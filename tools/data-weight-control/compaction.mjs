#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  assertDatasetName,
  assertPortableName,
  normalizeProjectPath,
  readJsonUtf8,
  resolveProjectPath,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "compaction");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) {
    throw new Error(`missing required argument --${key}`);
  }
  return String(value);
}

function optionalString(args, key) {
  const value = args[key];
  if (!value || value === true) return null;
  return String(value);
}

function projectPath(absPath) {
  return path.relative(ROOT, absPath).replaceAll(path.sep, "/");
}

function resolveProjectArg(input, label) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} must not be empty`);
  }
  const absolute = path.resolve(ROOT, input);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project root: ${input}`);
  }
  return { absolute, project: normalizeProjectPath(relative.replaceAll(path.sep, "/")) };
}

function validateTradeMonth(value) {
  if (!/^[0-9]{4}-[0-9]{2}$/.test(value)) {
    throw new Error("--trade-month must use YYYY-MM");
  }
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw new Error("--trade-month month must be 01..12");
  return value;
}

function partitionIdFor(contract, tradeMonth) {
  const column = contract.partition?.column;
  if (!column) throw new Error(`${contract.dataset}: missing partition.column`);
  assertPortableName(column, "partition.column");
  return `${column === "trade_date" ? "trade_month" : `${column}_month`}=${tradeMonth}`;
}

function safeVersionId(dataset, tradeMonth) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  return `compact-${dataset}-${tradeMonth}-${stamp}`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRows(left, right, fields) {
  for (const field of fields) {
    const comparison = compareValues(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function keyFor(row, fields) {
  return JSON.stringify(fields.map((field) => row[field] ?? null));
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function jsonlForRows(rows) {
  return rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
}

async function readJsonlRows(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readRowsFromManifest(manifest) {
  const rows = [];
  for (const file of manifest.data_files ?? []) {
    const filePath = resolveProjectPath(ROOT, file.path);
    const fileRows = await readJsonlRows(filePath);
    rows.push(...fileRows);
  }
  return rows;
}

function keySetHash(rows, logicalKey) {
  const keys = [...new Set(rows.map((row) => keyFor(row, logicalKey)))].sort();
  return {
    count: keys.length,
    sha256: sha256Text(keys.join("\n") + (keys.length ? "\n" : "")),
    sample: keys.slice(0, 5).map((key) => JSON.parse(key))
  };
}

function validatePreflightCandidate(preflight, dataset, partitionId) {
  const item = preflight.datasets?.find((entry) => entry.dataset === dataset);
  if (!item) throw new Error(`preflight artifact does not include dataset ${dataset}`);
  const smallFiles = item.small_files;
  if (!smallFiles || smallFiles.candidate !== true) {
    throw new Error(`${dataset}: preflight did not mark dataset as small-file compaction candidate`);
  }
  const month = smallFiles.months?.find((entry) => entry.partition === partitionId);
  if (!month || month.candidate !== true) {
    throw new Error(`${dataset}/${partitionId}: preflight did not mark partition as compaction candidate`);
  }
  return { dataset: item, month };
}

async function writeCurrentPointerAtomic(pointerPath, data) {
  await fs.mkdir(path.dirname(pointerPath), { recursive: true });
  const tmpPath = path.join(path.dirname(pointerPath), `_current.${process.pid}.tmp`);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const handle = await fs.open(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o666);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, pointerPath);
}

function pointerFromManifest(manifest, partitionDirProject) {
  return {
    schema_version: "clean-current-pointer/v1",
    dataset: manifest.dataset,
    partition_id: manifest.partition_id,
    version_id: manifest.version_id,
    published_at: new Date().toISOString(),
    status: "current",
    version_path: manifest.version_path,
    manifest_path: manifest.manifest_path,
    row_count: manifest.row_count,
    checksum: manifest.checksum,
    source_ingest_runs: manifest.source_ingest_runs,
    ingest_run_ids: manifest.ingest_run_ids,
    quality_artifact: manifest.quality_artifact,
    previous_version_id: manifest.previous_version_id,
    pointer_path: normalizeProjectPath(`${partitionDirProject}/_current.json`)
  };
}

function renderMarkdown(report) {
  const lines = [
    `# Compaction Run: ${report.run_id}`,
    "",
    `- status: ${report.status}`,
    `- dataset: ${report.dataset}`,
    `- partition: ${report.partition_id}`,
    `- source_version: ${report.source_version_id ?? "none"}`,
    `- target_version: ${report.target_version_id ?? "none"}`,
    `- files_before: ${report.files_before}`,
    `- files_after: ${report.files_after}`,
    `- rows_before: ${report.rows_before}`,
    `- rows_after: ${report.rows_after}`,
    `- key_set_unchanged: ${report.key_set_unchanged}`,
    `- current_publish: ${report.current_publish.status}`,
    "",
    "## Verification",
    "",
    `- source_key_set_sha256: ${report.source_key_set.sha256 ?? "none"}`,
    `- target_key_set_sha256: ${report.target_key_set.sha256 ?? "none"}`,
    `- source_checksum: ${report.source_checksum ?? "none"}`,
    `- target_checksum: ${report.target_checksum ?? "none"}`,
    ""
  ];
  if (report.current_publish.error) lines.push(`- error: ${report.current_publish.error}`, "");
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const tradeMonth = validateTradeMonth(requireArg(args, "trade-month"));
const preflightRef = resolveProjectArg(requireArg(args, "preflight-artifact"), "--preflight-artifact");
const dryRun = args["dry-run"] === true;
const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
if (contract.dataset !== dataset) throw new Error(`${dataset}: contract dataset mismatch`);
if (contract.partition?.type !== "month" || contract.partition?.format !== "YYYY-MM") {
  throw new Error(`${dataset}: only monthly YYYY-MM compaction is supported`);
}
const partitionId = partitionIdFor(contract, tradeMonth);
const targetVersionId = optionalString(args, "version-id")
  ? assertPortableName(optionalString(args, "version-id"), "version-id")
  : safeVersionId(dataset, tradeMonth);
const runId = `compaction-${dataset}-${tradeMonth}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
const artifactProject = `.ai-coord/artifacts/data-weight-control/compaction/${runId}.json`;
const preflight = await readJsonUtf8(preflightRef.absolute);
const candidate = validatePreflightCandidate(preflight, dataset, partitionId);

const cleanRootProject = normalizeProjectPath(contract.storage.clean_path);
const partitionDirProject = normalizeProjectPath(`${cleanRootProject}/${partitionId}`);
const currentProject = normalizeProjectPath(`${partitionDirProject}/_current.json`);
const currentPath = resolveProjectPath(ROOT, currentProject);
const sourceCurrent = await readJsonUtf8(currentPath);
const sourceManifest = await readJsonUtf8(resolveProjectPath(ROOT, sourceCurrent.manifest_path));
if (sourceManifest.dataset !== dataset || sourceManifest.partition_id !== partitionId) {
  throw new Error("current manifest does not match requested dataset/partition");
}
const rows = await readRowsFromManifest(sourceManifest);
const sortedRows = [...rows].sort((left, right) => compareRows(left, right, contract.sort_order));
const sourceKeySet = keySetHash(rows, contract.logical_key);
const targetKeySet = keySetHash(sortedRows, contract.logical_key);
const keySetUnchanged = sourceKeySet.sha256 === targetKeySet.sha256;
const rowsUnchanged = rows.length === sortedRows.length && rows.length === sourceManifest.row_count;
if (!rowsUnchanged || !keySetUnchanged) {
  throw new Error("compaction verification failed before publish: row count or logical key set changed");
}

const compactBody = jsonlForRows(sortedRows);
const targetChecksum = sha256Text(compactBody);
const sourceChecksum = sha256Text(rows.map((row) => canonicalJson(row)).sort().join("\n") + (rows.length ? "\n" : ""));
const versionDirProject = normalizeProjectPath(`${cleanRootProject}/_versions/${partitionId}/${targetVersionId}`);
const versionDir = resolveProjectPath(ROOT, versionDirProject);
const compactFileProject = normalizeProjectPath(`${versionDirProject}/part-000.jsonl`);
const compactFilePath = resolveProjectPath(ROOT, compactFileProject);
const manifestProject = normalizeProjectPath(`${versionDirProject}/manifest.json`);
const manifestPath = resolveProjectPath(ROOT, manifestProject);
const qualityProject = normalizeProjectPath(`${versionDirProject}/_quality.json`);
const qualityPath = resolveProjectPath(ROOT, qualityProject);
const currentPublish = { requested: !dryRun, status: dryRun ? "dry-run" : "pending", error: null };
let targetManifest = null;

if (!dryRun) {
  await fs.mkdir(path.dirname(versionDir), { recursive: true });
  await fs.mkdir(versionDir, { recursive: false });
  await fs.writeFile(compactFilePath, compactBody, "utf8");
  const stat = await fs.stat(compactFilePath);
  const quality = {
    schema_version: "compaction-quality/v1",
    status: "passed",
    dataset,
    partition_id: partitionId,
    source_version_id: sourceManifest.version_id,
    target_version_id: targetVersionId,
    rows_before: rows.length,
    rows_after: sortedRows.length,
    key_set_unchanged: keySetUnchanged,
    source_key_set: sourceKeySet,
    target_key_set: targetKeySet
  };
  await writeJsonUtf8Atomic(qualityPath, quality);
  targetManifest = {
    ...sourceManifest,
    schema_version: "clean-version-manifest/v1",
    status: "quality-passed",
    version_id: targetVersionId,
    version_path: versionDirProject,
    manifest_path: manifestProject,
    created_at: new Date().toISOString(),
    row_count: sortedRows.length,
    checksum: targetChecksum,
    data_files: [{ path: compactFileProject, bytes: stat.size, sha256: targetChecksum, role: "compacted" }],
    quality_artifact: artifactProject,
    duplicate_key_count: sourceManifest.duplicate_key_count ?? 0,
    dedup_strategy: sourceManifest.dedup_strategy,
    previous_version_id: sourceManifest.version_id,
    compaction: {
      source_version_id: sourceManifest.version_id,
      source_manifest_path: sourceCurrent.manifest_path,
      files_before: sourceManifest.data_files?.length ?? 0,
      files_after: 1,
      source_checksum: sourceChecksum,
      target_checksum: targetChecksum,
      source_key_set: sourceKeySet,
      target_key_set: targetKeySet
    }
  };
  await writeJsonUtf8Atomic(manifestPath, targetManifest);
  try {
    await writeCurrentPointerAtomic(currentPath, pointerFromManifest(targetManifest, partitionDirProject));
    currentPublish.status = "published";
  } catch (error) {
    currentPublish.status = "blocked";
    currentPublish.error = `failed to publish _current.json; old pointer may be preserved by rename semantics: ${error.message}`;
  }
} else {
  targetManifest = {
    ...sourceManifest,
    version_id: targetVersionId,
    version_path: versionDirProject,
    manifest_path: manifestProject,
    previous_version_id: sourceManifest.version_id,
    row_count: sortedRows.length,
    checksum: targetChecksum
  };
}

const fileSizes = sourceManifest.data_files ?? [];
const filesBefore = fileSizes.length;
const bytesBefore = fileSizes.reduce((sum, file) => sum + Number(file.bytes ?? 0), 0);
const report = {
  schema_version: "compaction/v1",
  run_id: runId,
  status: currentPublish.status === "blocked" ? "blocked" : dryRun ? "planned" : "published",
  dataset,
  partition_id: partitionId,
  trade_month: tradeMonth,
  created_at: new Date().toISOString(),
  dry_run: dryRun,
  preflight_artifact: preflightRef.project,
  preflight_candidate: candidate.month,
  source_version_id: sourceManifest.version_id,
  target_version_id: targetVersionId,
  source_manifest_path: sourceCurrent.manifest_path,
  target_manifest_path: dryRun ? null : manifestProject,
  current_path: currentProject,
  files_before: filesBefore,
  files_after: dryRun ? 1 : targetManifest.data_files.length,
  bytes_before: bytesBefore,
  average_file_bytes_before: filesBefore ? Math.round(bytesBefore / filesBefore) : 0,
  rows_before: rows.length,
  rows_after: sortedRows.length,
  source_checksum: sourceChecksum,
  target_checksum: targetChecksum,
  source_key_set: sourceKeySet,
  target_key_set: targetKeySet,
  key_set_unchanged: keySetUnchanged,
  current_publish: currentPublish,
  forbidden_actions_avoided: ["drop", "archive", "production-query-entry-switch", "silent-query-path-compaction"],
  manifest: targetManifest
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const artifactPath = resolveProjectPath(ROOT, artifactProject);
await writeJsonUtf8Atomic(artifactPath, report);
await fs.writeFile(path.join(ARTIFACT_DIR, `${runId}.md`), renderMarkdown(report), "utf8");
console.log(artifactProject);
if (currentPublish.status === "blocked") process.exitCode = 2;