#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  assertPortableName,
  normalizeProjectPath,
  readJsonUtf8,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "backtest-manifest");
const CLEAN_VERSION_SCHEMA = "clean-version-manifest/v1";
const CLEAN_POINTER_SCHEMA = "clean-current-pointer/v1";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
    if (value !== true) i += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true || Array.isArray(value)) throw new Error(`missing required argument --${key}`);
  return String(value);
}

function optionalString(args, key, fallback = null) {
  const value = args[key];
  if (!value || value === true || Array.isArray(value)) return fallback;
  return String(value);
}

function collectArgs(args, key) {
  const value = args[key];
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function projectPath(absPath) {
  return path.relative(ROOT, absPath).replaceAll(path.sep, "/");
}

function resolveProjectArg(input, label) {
  const absolute = path.resolve(ROOT, input);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside project root`);
  return { absolute, project: normalizeProjectPath(relative.replaceAll(path.sep, "/")) };
}

async function pathExists(projectRelativePath) {
  if (!projectRelativePath) return false;
  try {
    await fs.access(path.join(ROOT, ...projectRelativePath.split("/")), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeTextUtf8Atomic(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.open(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o666);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inferDependencyRole(dataset, category) {
  if (dataset.includes("bar")) return "bar";
  if (dataset === "daily_basic") return "daily-basic";
  if (dataset.includes("moneyflow")) return "moneyflow";
  if (dataset.includes("board")) return "board";
  return category ?? "other";
}
function normalizeIngestRuns(manifest) {
  const ids = Array.isArray(manifest.ingest_run_ids) ? manifest.ingest_run_ids : [];
  if (!ids.length) throw new Error(`clean manifest ${manifest.dataset}/${manifest.partition_id} is missing ingest_run_ids`);
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) throw new Error("ingest_run_ids must be non-empty strings from clean manifest");
  }
  return Array.from(new Set(ids)).sort();
}

function dateMaxFromManifest(manifest) {
  if (manifest.max_date) return manifest.max_date;
  if (manifest.date_range?.to) return manifest.date_range.to;
  if (Array.isArray(manifest.date_range) && manifest.date_range.length >= 2) return manifest.date_range[1];
  return null;
}

function dateRangeFromManifest(manifest) {
  if (manifest.date_range?.from || manifest.date_range?.to) return manifest.date_range;
  if (Array.isArray(manifest.date_range) && manifest.date_range.length >= 2) return { from: manifest.date_range[0], to: manifest.date_range[1] };
  return { from: null, to: dateMaxFromManifest(manifest) };
}

async function loadInput(cleanManifestArg) {
  const resolved = resolveProjectArg(cleanManifestArg, "input manifest");
  let manifest = await readJsonUtf8(resolved.absolute);
  let cleanManifestPath = resolved.project;
  let clean_pointer_path = null;
  if (manifest.schema_version === CLEAN_POINTER_SCHEMA) {
    clean_pointer_path = resolved.project;
    if (!manifest.manifest_path) throw new Error(`clean pointer ${resolved.project} is missing manifest_path`);
    const dereferenced = resolveProjectArg(manifest.manifest_path, "clean pointer manifest_path");
    manifest = await readJsonUtf8(dereferenced.absolute);
    cleanManifestPath = dereferenced.project;
  }
  if (manifest.schema_version !== CLEAN_VERSION_SCHEMA) {
    throw new Error(`input manifest ${cleanManifestPath} is not a clean partition manifest (schema_version=${manifest.schema_version})`);
  }
  if (manifest.status !== "quality-passed") {
    throw new Error(`clean manifest ${cleanManifestPath} must have status quality-passed, got ${manifest.status}`);
  }
  const dataset = manifest.dataset;
  if (!dataset) throw new Error(`clean manifest ${cleanManifestPath} is missing dataset`);
  const contractPath = path.join(CONTRACT_DIR, `${dataset}.json`);
  const contract = await readJsonUtf8(contractPath);
  const partitionPath = normalizeProjectPath(manifest.partition_path ?? manifest.version_path ?? manifest.data_path ?? path.posix.dirname(cleanManifestPath));
  const ingestRunIds = normalizeIngestRuns(manifest);
  const rowCount = Number.isInteger(manifest.row_count) ? manifest.row_count : null;
  if (rowCount === null) throw new Error(`clean manifest ${cleanManifestPath} is missing integer row_count`);
  const maxDate = dateMaxFromManifest(manifest);
  if (!maxDate) throw new Error(`clean manifest ${cleanManifestPath} is missing max_date or date_range.to`);
  if (!manifest.checksum) throw new Error(`clean manifest ${cleanManifestPath} is missing checksum`);
  const checksum = manifest.checksum;
  const partitionPathExists = await pathExists(partitionPath);
  return {
    dataset,
    contract_path: projectPath(contractPath),
    category: contract.category ?? null,
    dependency_role: inferDependencyRole(dataset, contract.category),
    clean_manifest_path: cleanManifestPath,
    clean_pointer_path,
    partition_id: manifest.partition_id ?? path.posix.basename(partitionPath),
    version_id: manifest.version_id ?? null,
    partition_path: partitionPath,
    partition_path_exists: partitionPathExists,
    row_count: rowCount,
    date_range: dateRangeFromManifest(manifest),
    max_date: maxDate,
    checksum,
    ingest_run_ids: ingestRunIds,
    ingest_run_ids_source: cleanManifestPath,
    source_ingest_runs: Array.isArray(manifest.source_ingest_runs) ? manifest.source_ingest_runs : [],
    quality_artifact: manifest.quality_artifact ?? null,
    accepted_exceptions: Array.isArray(manifest.accepted_exceptions) ? manifest.accepted_exceptions : []
  };
}

function renderMarkdown(manifest) {
  const lines = [
    `# Backtest Manifest: ${manifest.manifest_id}`,
    "",
    "## Summary",
    "",
    `- Status: ${manifest.status}`,
    `- Strategy: ${manifest.strategy.id}`,
    `- Strategy version: ${manifest.strategy.version}`,
    `- Code identity: ${manifest.strategy.code_identity}`,
    `- Generated at: ${manifest.generated_at}`,
    `- Input count: ${manifest.inputs.length}`,
    `- Copies inputs fully into DuckDB: ${manifest.reproducibility.copies_inputs_fully_into_duckdb}`,
    "",
    "## Inputs",
    "",
    "| Dataset | Role | Partition | Version | Rows | Max date | Ingest runs source |",
    "| --- | --- | --- | --- | ---: | --- | --- |"
  ];
  for (const input of manifest.inputs) {
    lines.push(`| ${input.dataset} | ${input.dependency_role} | ${input.partition_id} | ${input.version_id ?? "unknown"} | ${input.row_count} | ${input.max_date} | ${input.ingest_run_ids_source} |`);
  }
  lines.push("", "## Reproducibility", "");
  for (const input of manifest.inputs) {
    lines.push(`### ${input.dataset}`);
    lines.push(`- Dependency role: ${input.dependency_role}`);
    lines.push(`- Contract category: ${input.category ?? "unknown"}`);
    lines.push(`- Partition path: ${input.partition_path}`);
    lines.push(`- Partition path exists at generation: ${input.partition_path_exists}`);
    lines.push(`- Clean manifest: ${input.clean_manifest_path}`);
    lines.push(`- Row count: ${input.row_count}`);
    lines.push(`- Date range: ${input.date_range.from ?? "unknown"}..${input.date_range.to ?? "unknown"}`);
    lines.push(`- Checksum: ${input.checksum}`);
    lines.push(`- ingest_run_ids from clean manifest: ${input.ingest_run_ids.join(", ")}`);
    lines.push(`- Quality artifact: ${input.quality_artifact ?? "none"}`);
    lines.push("");
  }
  lines.push("## Accepted Gaps Or Quality Exceptions", "");
  if (manifest.accepted_exceptions.length) {
    for (const item of manifest.accepted_exceptions) lines.push(`- ${item}`);
  } else {
    lines.push("- none recorded");
  }
  lines.push(
    "",
    "## Non-Copy Statement",
    "",
    "This manifest records project-relative clean partition manifests and partition paths. It did not copy each backtest input fully into DuckDB as the default reproducibility mechanism.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const manifestId = assertPortableName(requireArg(args, "manifest-id"), "manifest-id");
const strategyId = assertPortableName(requireArg(args, "strategy-id"), "strategy-id");
const strategyVersion = requireArg(args, "strategy-version");
const codeIdentity = requireArg(args, "code-identity");
const generatedAt = optionalString(args, "generated-at", new Date().toISOString());
const inputManifestArgs = collectArgs(args, "input-manifest");
if (!inputManifestArgs.length) throw new Error("at least one --input-manifest is required");
if (args["ingest-run-ids"] !== undefined || args["ingest_run_ids"] !== undefined) {
  throw new Error("ingest_run_ids must come from clean partition manifests, not CLI arguments");
}

const inputs = [];
for (const item of inputManifestArgs) inputs.push(await loadInput(item));
const acceptedExceptions = [
  ...collectArgs(args, "accepted-exception"),
  ...inputs.flatMap((input) => input.accepted_exceptions.map((item) => `${input.dataset}: ${item}`))
];

const manifest = {
  schema_version: "backtest-manifest/v1",
  manifest_id: manifestId,
  status: inputs.every((input) => input.partition_path_exists) ? "ready" : "ready-with-reconstructable-clean-manifest",
  generated_at: generatedAt,
  created_at: new Date().toISOString(),
  strategy: {
    id: strategyId,
    version: strategyVersion,
    code_identity: codeIdentity
  },
  inputs,
  input_digest: stableHash(inputs.map((input) => ({ dataset: input.dataset, partition_id: input.partition_id, version_id: input.version_id, checksum: input.checksum, ingest_run_ids: input.ingest_run_ids }))),
  accepted_exceptions: acceptedExceptions,
  reproducibility: {
    method: "clean partition manifest plus project-relative partition paths",
    copies_inputs_fully_into_duckdb: false,
    ingest_run_ids_policy: "copied only from clean partition manifests"
  },
  forbidden_actions_avoided: ["copy-each-backtest-input-fully-into-duckdb-as-default-repro"]
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const jsonPath = path.join(ARTIFACT_DIR, `${manifestId}.json`);
const mdPath = path.join(ARTIFACT_DIR, `${manifestId}.md`);
await writeJsonUtf8Atomic(jsonPath, manifest);
await writeTextUtf8Atomic(mdPath, renderMarkdown(manifest));
console.log(projectPath(jsonPath));
console.log(projectPath(mdPath));
