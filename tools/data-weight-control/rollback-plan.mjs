#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  assertDatasetName,
  normalizeProjectPath,
  readJsonUtf8
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "rollback");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) throw new Error(`missing required argument --${key}`);
  return String(value);
}

function optionalString(args, key, fallback = "unknown") {
  const value = args[key];
  if (!value || value === true) return fallback;
  return String(value);
}

function projectPath(absPath) {
  return path.relative(ROOT, absPath).replaceAll(path.sep, "/");
}

function resolveOptionalProjectPath(input, label) {
  if (!input || input === "unknown") return "unknown";
  const absolute = path.resolve(ROOT, input);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside project root`);
  return normalizeProjectPath(relative.replaceAll(path.sep, "/"));
}

async function pathExists(projectRelativePath) {
  if (!projectRelativePath || projectRelativePath === "unknown") return false;
  try {
    await fs.access(path.join(ROOT, ...projectRelativePath.split("/")), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readVerification(projectRelativePath) {
  if (!projectRelativePath || projectRelativePath === "unknown") {
    return { status: "missing", summary: "no consistency verification artifact supplied" };
  }
  const absolute = path.join(ROOT, ...projectRelativePath.split("/"));
  try {
    const artifact = await readJsonUtf8(absolute);
    return {
      status: artifact.status ?? "unknown",
      run_id: artifact.run_id ?? "unknown",
      mode: artifact.mode ?? "unknown",
      duckdb: artifact.duckdb?.status ?? "unknown",
      failures: Array.isArray(artifact.failures) ? artifact.failures : [],
      summary: `verification artifact status is ${artifact.status ?? "unknown"}`
    };
  } catch (error) {
    return { status: "unreadable", summary: `verification artifact unreadable: ${error.message}` };
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

function markdownValue(value) {
  return String(value ?? "unknown").replace(/\r?\n/g, " ");
}

function contractSchemaSummary(contract) {
  if (Array.isArray(contract.columns)) {
    return contract.columns.map((column) => `${column.name}:${column.type}`).join(", ")
  }
  const logicalKey = Array.isArray(contract.logical_key) ? contract.logical_key.join("+") : "unknown"
  const sortOrder = Array.isArray(contract.sort_order) ? contract.sort_order.join("+") : "unknown"
  const partition = contract.partition ? `${contract.partition.type}:${contract.partition.column}:${contract.partition.format}` : "unknown"
  return `dataset:${contract.dataset}, logical_key:${logicalKey}, date_column:${contract.date_column ?? "unknown"}, partition:${partition}, sort_order:${sortOrder}, dedup:${contract.dedup?.mode ?? "unknown"}`
}

function renderApprovalTable() {
  return [
    "| Action | Required approval | Approval artifact | Execution allowed by this tool |",
    "| --- | --- | --- | --- |",
    "| Switch default query entry | human owner approval after passed verification | separate approval record | no |",
    "| Archive source table or backup | separate human owner approval | separate approval record | no |",
    "| Drop source table | separate human owner approval with rollback artifact attached | separate approval record | no |",
    "| Delete backup or retained old version | separate human owner approval after rollback window | separate approval record | no |"
  ].join("\n");
}

function renderRollbackCommands({ source_table: sourceTable, source_location: sourceLocation, backup_location: backupLocation, target_partitions: targetPartitions, target_view: targetView }) {
  return [
    "### Command Templates",
    "",
    "These are recovery templates only. This tool did not execute them.",
    "Run any command only after the separate human approval item that matches the action.",
    "",
    "```sql",
    "-- Failure before query-entry switch:",
    "-- keep the existing query path on the source table and do not archive or drop the source.",
    "",
    "-- Failure after query-entry switch but before source drop:",
    `CREATE OR REPLACE VIEW ${targetView} AS SELECT * FROM ${sourceTable};`,
    "",
    "-- Restore an equivalent source table from retained Parquet partitions if the source was already removed by an approved task:",
    `CREATE OR REPLACE TABLE ${sourceTable} AS SELECT * FROM read_parquet('${targetPartitions}/**/*.parquet');`,
    "",
    "-- Restore an equivalent query view directly over the target partitions:",
    `CREATE OR REPLACE VIEW ${targetView} AS SELECT * FROM read_parquet('${targetPartitions}/**/*.parquet');`,
    "```",
    "",
    `Source location record: ${sourceLocation}`,
    `Backup location record: ${backupLocation}`
  ].join("\n");
}

function renderMarkdown(data) {
  const verificationPassed = data.verification.status === "passed";
  const durableRecovery = data.backup_location !== "unknown" || (data.target_partitions !== "unknown" && data.target_partitions_exist === true)
  const recordStatus = verificationPassed && durableRecovery ? "ready-for-human-approval" : "blocked"
  const gateReasons = [];
  if (!verificationPassed) gateReasons.push(`consistency verification is ${data.verification.status}`);
  if (!durableRecovery) gateReasons.push("no durable post-drop recovery path (backup or existing target parquet)")
  if (!gateReasons.length) gateReasons.push("all rollback record prerequisites are present, but destructive actions still require separate approval");

  return `${[
    `# Rollback Record: ${data.run_id}`,
    "",
    "## Status",
    "",
    `- Record status: ${recordStatus}`,
    `- Dataset: ${data.dataset}`,
    `- Created at: ${data.created_at}`,
    `- Contract: ${data.contract_path}`,
    `- Consistency verification artifact: ${data.verify_artifact}`,
    `- Consistency verification status: ${data.verification.status}`,
    `- DuckDB status in verification: ${data.verification.duckdb ?? "unknown"}`,
    `- Gate reason: ${gateReasons.join("; ")}`,
    "",
    "## Source Record",
    "",
    `- Source table: ${markdownValue(data.source_table)}`,
    `- Source schema: ${markdownValue(data.source_schema)}`,
    `- Source row count: ${markdownValue(data.row_count)}`,
    `- Source date range: ${markdownValue(data.date_range)}`,
    `- Source location: ${markdownValue(data.source_location)}`,
    `- Backup location: ${markdownValue(data.backup_location)}`,
    "",
    "## Target Record",
    "",
    `- Target Parquet partitions: ${markdownValue(data.target_partitions)}`,
    `- Target view: ${markdownValue(data.target_view)}`,
    `- Target partitions exist now: ${data.target_partitions_exist}`,
    "",
    "## Recovery Steps",
    "",
    "1. If migration verification is not passed, keep or restore the pre-migration query path immediately.",
    "2. If a query-entry switch happened but source data is retained, point the query entry back to the source table or previous view.",
    "3. If the source table was dropped by a separately approved task, rebuild the table or equivalent view from the retained backup or target Parquet partitions.",
    "4. Re-run migration verification after restoration. Do not archive, drop, or delete backup material until verification is passed and the human owner approves the next action.",
    "5. If restoration cannot be verified, keep service on the last known good pre-migration query path. Half-switched service is not allowed.",
    "",
    renderRollbackCommands(data),
    "",
    "## Manual Confirmation Items",
    "",
    renderApprovalTable(),
    "",
    "## Non-Execution Statement",
    "",
    "This artifact is a rollback and approval record only. The generator did not run SQL, did not switch query entries, did not archive data, did not drop tables, and did not delete backups.",
    "",
    "## Verification Artifact Details",
    "",
    `- Verification run id: ${data.verification.run_id ?? "unknown"}`,
    `- Verification mode: ${data.verification.mode ?? "unknown"}`,
    `- Verification summary: ${data.verification.summary}`,
    `- Verification failures: ${data.verification.failures?.length ? data.verification.failures.join("; ") : "none recorded"}`,
    ""
  ].join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const runId = `rollback-${dataset}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
const contractPath = path.join(CONTRACT_DIR, `${dataset}.json`);
const contract = await readJsonUtf8(contractPath);
const verifyArtifact = resolveOptionalProjectPath(optionalString(args, "verify-artifact"), "verify artifact");
const targetPartitions = resolveOptionalProjectPath(optionalString(args, "target-partitions"), "target partitions");
const backupLocationArg = optionalString(args, "backup-location");
const backupLocation = backupLocationArg === "unknown" ? "unknown" : resolveOptionalProjectPath(backupLocationArg, "backup location");
const verification = await readVerification(verifyArtifact);
const sourceTable = optionalString(args, "source-table", `${dataset}`);
const targetView = optionalString(args, "target-view", `${dataset}_external_view`);
const sourceLocation = optionalString(args, "source-location")
const targetPartitionsExist = await pathExists(targetPartitions);
const artifactPath = path.join(ARTIFACT_DIR, `${runId}.md`);

const sourceSchema = optionalString(
  args,
  "source-schema",
  contractSchemaSummary(contract)
);

const body = renderMarkdown({
  run_id: runId,
  dataset,
  created_at: new Date().toISOString(),
  contract_path: projectPath(contractPath),
  verify_artifact: verifyArtifact,
  verification,
  source_table: sourceTable,
  source_schema: sourceSchema,
  row_count: optionalString(args, "row-count"),
  date_range: optionalString(args, "date-range"),
  source_location: sourceLocation,
  backup_location: backupLocation,
  target_partitions: targetPartitions,
  target_partitions_exist: targetPartitionsExist,
  target_view: targetView
});

await writeTextUtf8Atomic(artifactPath, body);
console.log(projectPath(artifactPath));
