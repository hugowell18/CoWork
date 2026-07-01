#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  normalizeProjectPath,
  readJsonUtf8,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "hot-layer");
const ALLOWED_HOT_MODES = new Set(["all-history", "rolling-window", "external-only", "metadata-only"]);

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

function optionalString(args, key) {
  const value = args[key];
  if (!value || value === true) return null;
  return String(value);
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

async function loadContracts() {
  const entries = await fs.readdir(CONTRACT_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "schema.json")
    .map((entry) => entry.name)
    .sort();
  const contracts = [];
  for (const file of files) {
    const absolute = path.join(CONTRACT_DIR, file);
    contracts.push({ file: projectPath(absolute), contract: await readJsonUtf8(absolute) });
  }
  return contracts;
}

async function loadUsageObservations(input) {
  if (!input) {
    return { source: null, global_hot_window_days: null, datasets: new Map(), notes: ["no usage observations supplied"] };
  }
  const resolved = resolveProjectArg(input, "usage observations");
  const body = await readJsonUtf8(resolved.absolute);
  const map = new Map();
  for (const item of Array.isArray(body.datasets) ? body.datasets : []) {
    if (item?.dataset) map.set(item.dataset, item);
  }
  return {
    source: resolved.project,
    global_hot_window_days: Number.isInteger(body.global_hot_window_days) ? body.global_hot_window_days : null,
    datasets: map,
    notes: Array.isArray(body.notes) ? body.notes : []
  };
}

function expectedDuckdbUse(contract) {
  const mode = contract.hot_layer?.mode;
  if (mode === "all-history") {
    return "all-history availability is allowed only by this dataset contract; do not truncate by a global window";
  }
  if (mode === "rolling-window") {
    return `materialized hot mart is limited to rolling-${contract.hot_layer.window_days}d; full history remains Parquet-first`;
  }
  if (mode === "external-only") {
    return "DuckDB may query external Parquet views, but full-history materialization is outside the contract";
  }
  if (mode === "metadata-only") {
    return "DuckDB should keep metadata only for this dataset";
  }
  return "unknown hot layer mode";
}

function martWindow(contract) {
  const mode = contract.hot_layer?.mode;
  if (mode === "rolling-window") return `window=rolling-${contract.hot_layer.window_days}d`;
  return `window=${mode ?? "unknown"}`;
}

function evaluateUsage(contract, observation, globalHotWindowDays) {
  const mode = contract.hot_layer?.mode;
  const issues = [];
  const role = observation?.duckdb_role ?? "not-observed";
  const observedWindow = Number.isInteger(observation?.window_days) ? observation.window_days : null;

  if (!ALLOWED_HOT_MODES.has(mode)) issues.push(`invalid hot_layer.mode ${mode}`);
  if (mode === "rolling-window" && !Number.isInteger(contract.hot_layer?.window_days)) {
    issues.push("rolling-window contract is missing window_days");
  }
  if (globalHotWindowDays !== null && mode === "all-history") {
    issues.push(`global hot window ${globalHotWindowDays}d would truncate all-history contract`);
  }

  if (role === "all-history-materialized" && mode !== "all-history") {
    issues.push(`observed all-history DuckDB materialization exceeds ${mode} contract`);
  }
  if (role === "rolling-window-materialized") {
    if (mode === "all-history") issues.push("observed rolling-window materialization would truncate all-history contract");
    if (mode === "rolling-window" && observedWindow !== null && observedWindow > contract.hot_layer.window_days) {
      issues.push(`observed rolling window ${observedWindow}d exceeds contract ${contract.hot_layer.window_days}d`);
    }
    if (mode === "external-only" || mode === "metadata-only") {
      issues.push(`observed rolling-window materialization exceeds ${mode} contract`);
    }
  }
  if (role === "metadata-only" && mode !== "metadata-only") {
    issues.push(`observed metadata-only use may be too narrow for ${mode} contract`);
  }

  return {
    observed_role: role,
    observed_window_days: observedWindow,
    observation_notes: observation?.notes ?? null,
    exceeds_contract: issues.length > 0,
    issues
  };
}

function datasetDecision(contract, usage, globalHotWindowDays) {
  const mode = contract.hot_layer?.mode ?? "unknown";
  const usageEvaluation = evaluateUsage(contract, usage, globalHotWindowDays);
  const candidateSources = [];
  if (contract.migration?.candidate === true) candidateSources.push("contract");
  if (usageEvaluation.exceeds_contract) candidateSources.push("usage-over-contract");
  if (mode === "rolling-window" && contract.strategy_risks?.includes("high-growth")) candidateSources.push("first-priority-hot-window-governance");
  if (contract.strategy_risks?.includes("symbol-cross-history")) candidateSources.push("requires-pruning-proof");

  const actions = [];
  if (mode === "all-history") actions.push("keep all history available and reject global truncation");
  if (mode === "rolling-window") actions.push(`materialize only ${martWindow(contract)} hot mart by contract`);
  if (mode === "external-only") actions.push("use DuckDB external Parquet view only until separately verified and approved");
  if (contract.strategy_risks?.includes("symbol-cross-history")) actions.push("prove symbol partition, sort, or pruning behavior before any default query entry switch");
  if (candidateSources.length) actions.push("treat as migration or externalization candidate before expanding DuckDB use");

  return {
    dataset: contract.dataset,
    category: contract.category,
    contract_hot_layer: contract.hot_layer,
    mart_path: contract.storage?.mart_path ?? null,
    expected_mart_window: martWindow(contract),
    expected_duckdb_use: expectedDuckdbUse(contract),
    strategy_risks: contract.strategy_risks ?? [],
    migration_candidate: candidateSources.length > 0,
    contract_migration_candidate: contract.migration?.candidate === true,
    candidate_sources: Array.from(new Set(candidateSources)),
    candidate_reason: contract.migration?.candidate_reason ?? null,
    usage_evaluation: usageEvaluation,
    requires_migration_verification_before_switch: candidateSources.length > 0,
    query_entry_switch_allowed: false,
    recommended_actions: actions,
    forbidden_actions_avoided: ["unverified-query-entry-switch", "drop", "archive"]
  };
}

function summarize(datasets, globalHotWindowDays) {
  const byMode = {};
  for (const item of datasets) byMode[item.contract_hot_layer.mode] = (byMode[item.contract_hot_layer.mode] ?? 0) + 1;
  return {
    dataset_count: datasets.length,
    hot_layer_modes: byMode,
    migration_candidate_count: datasets.filter((item) => item.migration_candidate).length,
    usage_over_contract_count: datasets.filter((item) => item.usage_evaluation.exceeds_contract).length,
    global_hot_window_status: globalHotWindowDays === null ? "not-set" : "observed-and-rejected",
    global_hot_window_days: globalHotWindowDays,
    query_entry_switches: 0,
    drops: 0,
    archives: 0
  };
}

function renderMarkdown(report) {
  const lines = [
    `# Hot Layer Report: ${report.run_id}`,
    "",
    "## Summary",
    "",
    `- Status: ${report.status}`,
    `- Contract source: ${report.contract_source}`,
    `- Usage observations: ${report.usage_observations_source ?? "none"}`,
    `- Global hot window status: ${report.summary.global_hot_window_status}`,
    `- Dataset count: ${report.summary.dataset_count}`,
    `- Migration candidate count: ${report.summary.migration_candidate_count}`,
    `- Usage over contract count: ${report.summary.usage_over_contract_count}`,
    `- Query entry switches executed: ${report.summary.query_entry_switches}`,
    `- Drop operations executed: ${report.summary.drops}`,
    `- Archive operations executed: ${report.summary.archives}`,
    "",
    "## Dataset Decisions",
    "",
    "| Dataset | Hot layer | Mart window | Candidate | Usage over contract | Required guard |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const item of report.datasets) {
    const guard = item.recommended_actions.join("; ").replaceAll("|", "/");
    lines.push(`| ${item.dataset} | ${item.contract_hot_layer.mode} | ${item.expected_mart_window} | ${item.migration_candidate} | ${item.usage_evaluation.exceeds_contract} | ${guard} |`);
  }
  lines.push(
    "",
    "## Contract Notes",
    ""
  );
  for (const item of report.datasets) {
    lines.push(`### ${item.dataset}`);
    lines.push(`- Expected DuckDB use: ${item.expected_duckdb_use}`);
    lines.push(`- Strategy risks: ${item.strategy_risks.length ? item.strategy_risks.join(", ") : "none"}`);
    lines.push(`- Candidate sources: ${item.candidate_sources.length ? item.candidate_sources.join(", ") : "none"}`);
    lines.push(`- Usage issues: ${item.usage_evaluation.issues.length ? item.usage_evaluation.issues.join("; ") : "none"}`);
    lines.push(`- Query entry switch allowed by this report: ${item.query_entry_switch_allowed}`);
    lines.push("");
  }
  lines.push(
    "## Non-Execution Statement",
    "",
    "This report did not connect to DuckDB, did not create or switch query entries, did not drop tables, and did not archive data. It rejects any global hot window as a governance input and records dataset-level contract decisions only.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const usageInput = optionalString(args, "usage-observations");
const contracts = await loadContracts();
const usage = await loadUsageObservations(usageInput);
const runId = `hot-layer-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
const datasets = contracts.map(({ contract }) => datasetDecision(contract, usage.datasets.get(contract.dataset), usage.global_hot_window_days));
const report = {
  schema_version: "hot-layer-report/v1",
  run_id: runId,
  status: "completed",
  created_at: new Date().toISOString(),
  contract_source: projectPath(CONTRACT_DIR),
  usage_observations_source: usage.source,
  duckdb_connection: { used: false, reason: "contract-level hot layer governance does not require query verification" },
  global_hot_window_policy: {
    configured_by_report: false,
    accepted: false,
    observed_global_hot_window_days: usage.global_hot_window_days,
    rule: "hot windows must be declared per dataset contract"
  },
  summary: summarize(datasets, usage.global_hot_window_days),
  datasets,
  forbidden_actions_avoided: ["unverified-query-entry-switch", "drop", "archive"]
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const jsonPath = path.join(ARTIFACT_DIR, `${runId}.json`);
const mdPath = path.join(ARTIFACT_DIR, `${runId}.md`);
await writeJsonUtf8Atomic(jsonPath, report);
await writeTextUtf8Atomic(mdPath, renderMarkdown(report));
console.log(projectPath(jsonPath));
console.log(projectPath(mdPath));