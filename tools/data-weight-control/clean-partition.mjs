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
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "clean-partition");
const VALID_QUALITY_STATUS = new Set(["passed", "failed", "blocked", "pending"]);

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
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true || Array.isArray(value)) {
    throw new Error(`missing required argument --${key}`);
  }
  return String(value);
}

function optionalString(args, key) {
  const value = args[key];
  if (!value || value === true || Array.isArray(value)) return null;
  return String(value);
}

function valuesOf(args, key) {
  const value = args[key];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
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
  const persisted = normalizeProjectPath(relative.replaceAll(path.sep, "/"));
  return {
    absolute,
    project: persisted
  };
}

function validateTradeMonth(value) {
  if (!/^[0-9]{4}-[0-9]{2}$/.test(value)) {
    throw new Error("--trade-month must use YYYY-MM");
  }
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new Error("--trade-month month must be 01..12");
  }
  return value;
}

function partitionKeyFor(contract) {
  const column = contract.partition?.column;
  if (!column) {
    throw new Error(`${contract.dataset}: missing partition.column`);
  }
  assertPortableName(column, "partition.column");
  return column === "trade_date" ? "trade_month" : `${column}_month`;
}

function partitionIdFor(contract, tradeMonth) {
  const key = partitionKeyFor(contract);
  return `${key}=${tradeMonth}`;
}

function validatePartitionId(value) {
  if (!/^[a-z0-9_]+=[0-9]{4}-[0-9]{2}$/.test(value)) {
    throw new Error(`partition id must be lowercase and shaped like trade_month=YYYY-MM: ${value}`);
  }
  return value;
}

function safeVersionId(dataset, partitionId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  const month = partitionId.split("=")[1];
  return `clean-${dataset}-${month}-${stamp}`;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function combinedChecksum(files, rowCount) {
  const hash = createHash("sha256");
  hash.update("clean-partition-manifest-v1\n");
  hash.update(`row_count=${rowCount}\n`);
  for (const file of files) {
    hash.update(`${file.path}\t${file.bytes}\t${file.sha256}\n`);
  }
  return hash.digest("hex");
}

async function assertNoCaseVariant(parentDir, segment, label) {
  if (!(await fileExists(parentDir))) return;
  const entries = await fs.readdir(parentDir, { withFileTypes: true });
  const variant = entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase() && entry.name !== segment);
  if (variant) {
    throw new Error(`${label} has a case-only collision: requested ${segment}, found ${variant.name}`);
  }
}

async function readCurrentPointer(pointerPath) {
  try {
    return await readJsonUtf8(pointerPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`cannot read existing _current.json; refusing to publish over uncertain state: ${error.message}`);
  }
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

async function copyDataFiles(inputFiles, versionDir, versionDirProject) {
  const copied = [];
  for (const [index, input] of inputFiles.entries()) {
    const source = resolveProjectArg(input, `--data-file[${index}]`);
    const stat = await fs.stat(source.absolute);
    if (!stat.isFile()) {
      throw new Error(`--data-file must point to a file: ${source.project}`);
    }
    const ext = path.extname(source.absolute).toLowerCase() || ".parquet";
    const targetName = `part-${String(index).padStart(3, "0")}${ext}`;
    const targetPath = path.join(versionDir, targetName);
    await fs.copyFile(source.absolute, targetPath, fsConstants.COPYFILE_EXCL);
    copied.push({
      path: normalizeProjectPath(`${versionDirProject}/${targetName}`),
      bytes: stat.size,
      sha256: await sha256File(targetPath),
      source_path: source.project
    });
  }
  return copied;
}

async function readSourceIngestRuns(dataset, sourceArtifactArgs, { allowPlannedIngest }) {
  const runs = [];
  for (const input of sourceArtifactArgs) {
    const artifactRef = resolveProjectArg(input, "--source-ingest-artifact");
    const artifact = await readJsonUtf8(artifactRef.absolute);
    const metadata = artifact.metadata;
    if (!metadata || metadata.dataset !== dataset) {
      throw new Error(`${artifactRef.project}: source ingest artifact dataset mismatch`);
    }
    if (artifact.status !== "written" && !(allowPlannedIngest && artifact.status === "planned")) {
      throw new Error(`${artifactRef.project}: source ingest artifact must be written before clean publish`);
    }
    if (!metadata.usable_scope?.allowed_consumers?.includes("clean")) {
      throw new Error(`${artifactRef.project}: usable_scope does not allow clean consumption`);
    }
    const metadataFile = metadata.files?.find((file) => file.role === "metadata");
    runs.push({
      source: metadata.source,
      ingest_run_id: metadata.ingest_run_id,
      fetch_time: metadata.fetch_time,
      usable_scope: metadata.usable_scope,
      trade_date_range: metadata.trade_date_range,
      raw_metadata_path: metadataFile?.path ?? null,
      ingest_artifact: artifactRef.project,
      artifact_status: artifact.status
    });
  }
  return runs;
}

function dateRangeFromSources(sources, fallbackMonth) {
  const dates = [];
  for (const source of sources) {
    if (source.trade_date_range?.from) dates.push(source.trade_date_range.from);
    if (source.trade_date_range?.to) dates.push(source.trade_date_range.to);
  }
  if (!dates.length) {
    return {
      from: `${fallbackMonth}-01`,
      to: `${fallbackMonth}-01`
    };
  }
  dates.sort();
  return {
    from: dates[0],
    to: dates[dates.length - 1]
  };
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

async function verifyCurrentPointer(pointerPath, expected) {
  const pointer = await readJsonUtf8(pointerPath);
  const versionPath = resolveProjectPath(ROOT, pointer.version_path);
  const manifestPath = resolveProjectPath(ROOT, pointer.manifest_path);
  const manifest = await readJsonUtf8(manifestPath);
  const ok =
    pointer.dataset === expected.dataset &&
    pointer.partition_id === expected.partition_id &&
    pointer.version_id === expected.version_id &&
    manifest.dataset === expected.dataset &&
    manifest.partition_id === expected.partition_id &&
    manifest.version_id === expected.version_id &&
    await fileExists(versionPath);
  if (!ok) {
    throw new Error("_current.json verification failed");
  }
  return {
    pointer_path: projectPath(pointerPath),
    version_path: pointer.version_path,
    manifest_path: pointer.manifest_path
  };
}

function renderMarkdown(artifact) {
  const lines = [
    `# Clean Partition Run: ${artifact.run_id}`,
    "",
    `- status: ${artifact.status}`,
    `- dataset: ${artifact.dataset}`,
    `- partition: ${artifact.partition_id}`,
    `- version: ${artifact.version_id}`,
    `- quality: ${artifact.quality_status}`,
    `- manifest: ${artifact.manifest_path ?? "not-written"}`,
    `- current: ${artifact.current_path ?? "not-published"}`,
    "",
    "## Publish",
    "",
    `- requested: ${artifact.publish.requested}`,
    `- status: ${artifact.publish.status}`,
    `- previous_version_id: ${artifact.previous_version_id ?? "none"}`
  ];
  if (artifact.publish.error) {
    lines.push(`- error: ${artifact.publish.error}`);
  }
  lines.push("", "## Source Ingest Runs", "");
  if (artifact.source_ingest_runs.length) {
    for (const run of artifact.source_ingest_runs) {
      lines.push(`- ${run.ingest_run_id} (${run.source}, ${run.usable_scope.status})`);
    }
  } else {
    lines.push("- none");
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const tradeMonth = validateTradeMonth(requireArg(args, "trade-month"));
const rowCount = parseNonNegativeInteger(requireArg(args, "row-count"), "--row-count");
const qualityStatus = String(args["quality-status"] ?? "pending");
if (!VALID_QUALITY_STATUS.has(qualityStatus)) {
  throw new Error("--quality-status must be one of passed, failed, blocked, pending");
}
const publishRequested = args.publish === true;
const dryRun = args["dry-run"] === true;
const allowPlannedIngest = args["allow-planned-ingest"] === true;
if (allowPlannedIngest && !dryRun) {
  throw new Error("--allow-planned-ingest is only valid with --dry-run");
}

const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
if (contract.dataset !== dataset) {
  throw new Error(`${dataset}: contract dataset mismatch`);
}
if (contract.partition?.type !== "month" || contract.partition?.format !== "YYYY-MM") {
  throw new Error(`${dataset}: only monthly YYYY-MM clean partitions are supported`);
}

const partitionId = validatePartitionId(partitionIdFor(contract, tradeMonth));
const versionId = optionalString(args, "version-id")
  ? assertPortableName(optionalString(args, "version-id"), "version-id")
  : safeVersionId(dataset, partitionId);
const qualityArtifactArg = optionalString(args, "quality-artifact");
if (!qualityArtifactArg) {
  throw new Error("missing required argument --quality-artifact");
}
const qualityArtifact = resolveProjectArg(qualityArtifactArg, "--quality-artifact");
if (!dryRun && !(await fileExists(qualityArtifact.absolute))) {
  throw new Error(`quality artifact does not exist: ${qualityArtifact.project}`);
}

const sourceIngestArtifactArgs = valuesOf(args, "source-ingest-artifact");
if (!dryRun && !sourceIngestArtifactArgs.length) {
  throw new Error("missing required argument --source-ingest-artifact for non-dry-run clean version writes");
}
const sourceIngestRuns = await readSourceIngestRuns(
  dataset,
  sourceIngestArtifactArgs,
  { allowPlannedIngest }
);
const ingestRunIds = [...new Set(sourceIngestRuns.map((run) => run.ingest_run_id))].sort();
const dataFileInputs = valuesOf(args, "data-file");
if (!dryRun && !dataFileInputs.length) {
  throw new Error("missing required argument --data-file for non-dry-run clean version writes");
}

const cleanRootProject = normalizeProjectPath(contract.storage.clean_path);
const partitionDirProject = normalizeProjectPath(`${cleanRootProject}/${partitionId}`);
const versionsRootProject = normalizeProjectPath(`${cleanRootProject}/_versions/${partitionId}`);
const versionDirProject = normalizeProjectPath(`${versionsRootProject}/${versionId}`);
const manifestProject = normalizeProjectPath(`${versionDirProject}/manifest.json`);
const currentProject = normalizeProjectPath(`${partitionDirProject}/_current.json`);
const cleanRoot = resolveProjectPath(ROOT, cleanRootProject);
const partitionDir = resolveProjectPath(ROOT, partitionDirProject);
const versionsRoot = resolveProjectPath(ROOT, versionsRootProject);
const versionDir = resolveProjectPath(ROOT, versionDirProject);
const manifestPath = resolveProjectPath(ROOT, manifestProject);
const currentPath = resolveProjectPath(ROOT, currentProject);

await assertNoCaseVariant(path.dirname(cleanRoot), path.basename(cleanRoot), "clean root");
await assertNoCaseVariant(cleanRoot, partitionId, "partition directory");
await assertNoCaseVariant(path.join(cleanRoot, "_versions"), partitionId, "version partition directory");
await assertNoCaseVariant(versionsRoot, versionId, "version directory");

const previousCurrent = await readCurrentPointer(currentPath);
const previousVersionId = previousCurrent?.version_id ?? null;
const createdAt = new Date().toISOString();
const qualityPath = qualityArtifact.project;
const dateRange = dateRangeFromSources(sourceIngestRuns, tradeMonth);
const publish = {
  requested: publishRequested,
  status: dryRun ? "dry-run" : "not-requested",
  error: null
};
let dataFiles = [];
let manifest = null;
let verification = null;

if (!dryRun) {
  await fs.mkdir(path.dirname(versionDir), { recursive: true });
  await fs.mkdir(versionDir, { recursive: false });
  dataFiles = await copyDataFiles(dataFileInputs, versionDir, versionDirProject);
}

const checksum = optionalString(args, "checksum") ?? combinedChecksum(dataFiles, rowCount);
manifest = {
  schema_version: "clean-version-manifest/v1",
  dataset,
  partition_id: partitionId,
  partition: {
    type: "month",
    column: contract.partition.column,
    value: tradeMonth
  },
  version_id: versionId,
  version_path: versionDirProject,
  manifest_path: manifestProject,
  created_at: createdAt,
  status: qualityStatus === "passed" ? "quality-passed" : `quality-${qualityStatus}`,
  logical_key: contract.logical_key,
  date_column: contract.date_column,
  date_range: dateRange,
  row_count: rowCount,
  checksum,
  data_files: dataFiles,
  source_ingest_runs: sourceIngestRuns,
  ingest_run_ids: ingestRunIds,
  quality_artifact: qualityPath,
  duplicate_key_count: args["duplicate-key-count"] === undefined
    ? null
    : parseNonNegativeInteger(String(args["duplicate-key-count"]), "--duplicate-key-count"),
  dedup_strategy: contract.dedup?.mode ?? null,
  previous_version_id: previousVersionId
};

if (!dryRun) {
  await writeJsonUtf8Atomic(manifestPath, manifest);
}

if (publishRequested && !dryRun) {
  if (qualityStatus !== "passed") {
    publish.status = "blocked";
    publish.error = `quality-status=${qualityStatus}; _current.json was not updated`;
  } else {
    const pointer = pointerFromManifest(manifest, partitionDirProject);
    try {
      await writeCurrentPointerAtomic(currentPath, pointer);
      verification = await verifyCurrentPointer(currentPath, {
        dataset,
        partition_id: partitionId,
        version_id: versionId
      });
      publish.status = "published";
    } catch (error) {
      publish.status = "blocked";
      publish.error = `failed to atomically publish _current.json; previous pointer preserved: ${error.message}`;
    }
  }
}

const runId = `clean-${dataset}-${tradeMonth}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
const artifact = {
  run_id: runId,
  status: publish.status === "blocked" ? "blocked" : dryRun ? "planned" : publish.status === "published" ? "published" : "staged",
  dataset,
  partition_id: partitionId,
  version_id: versionId,
  created_at: createdAt,
  dry_run: dryRun,
  quality_status: qualityStatus,
  clean_path: cleanRootProject,
  version_path: versionDirProject,
  manifest_path: dryRun ? null : manifestProject,
  current_path: publish.status === "published" ? currentProject : null,
  previous_version_id: previousVersionId,
  source_ingest_runs: sourceIngestRuns,
  ingest_run_ids: ingestRunIds,
  row_count: rowCount,
  checksum,
  data_files: dataFiles,
  quality_artifact: qualityPath,
  publish,
  verification,
  manifest
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const artifactJson = path.join(ARTIFACT_DIR, `${runId}.json`);
const artifactMd = path.join(ARTIFACT_DIR, `${runId}.md`);
await writeJsonUtf8Atomic(artifactJson, artifact);
await fs.writeFile(artifactMd, renderMarkdown(artifact), "utf8");

console.log(projectPath(artifactJson));
if (dryRun) {
  console.log(`dry-run version: ${versionDirProject}`);
} else if (publish.status === "published") {
  console.log(`published current pointer: ${currentProject}`);
} else {
  console.log(`wrote clean version: ${versionDirProject}`);
}
if (publish.status === "blocked") {
  process.exitCode = 2;
}
