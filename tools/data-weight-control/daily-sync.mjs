#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  assertDatasetName,
  assertPortableName,
  normalizeProjectPath,
  readJsonUtf8,
  resolveProjectPath,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const SYNC_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "sync");
const MART_REFRESH_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "mart-refresh");

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

function validateTradeDate(value) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new Error("--trade-date must use YYYY-MM-DD");
  }
  return value;
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
  return {
    absolute,
    project: normalizeProjectPath(relative.replaceAll(path.sep, "/"))
  };
}

async function runNodeTool(toolName, args) {
  try {
    const result = await execFileAsync(process.execPath, [path.join(SCRIPT_DIR, toolName), ...args], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8
    });
    return {
      exit_code: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    };
  } catch (error) {
    return {
      exit_code: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? error.message ?? "").trim()
    };
  }
}

function firstJsonPath(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.trim().endsWith(".json"));
  return line ? normalizeProjectPath(line.trim()) : null;
}

function stepRecord(name, status, details = {}) {
  return {
    name,
    status,
    started_at: details.started_at ?? null,
    finished_at: details.finished_at ?? new Date().toISOString(),
    ...details
  };
}

function renderMarkdown(report) {
  const lines = [
    `# Daily Sync: ${report.run_id}`,
    "",
    `- status: ${report.status}`,
    `- dataset: ${report.dataset}`,
    `- trade_date: ${report.trade_date}`,
    `- dry_run: ${report.dry_run}`,
    `- stopped_after: ${report.stopped_after ?? "none"}`,
    "",
    "## Steps",
    ""
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.name}: ${step.status}`);
  }
  lines.push("", "## Artifacts", "");
  lines.push(`- sync: ${report.sync_artifact}`);
  lines.push(`- mart_refresh: ${report.mart_refresh_artifact ?? "not-written"}`);
  return `${lines.join("\n")}\n`;
}

async function writeMartRefreshArtifact({ runId, contract, cleanPublish, dryRun }) {
  const martPath = contract.storage.mart_path
    ? normalizeProjectPath(contract.storage.mart_path)
    : normalizeProjectPath(`data/marts/${contract.dataset}/window=${contract.hot_layer.mode}`);
  const martDir = resolveProjectPath(ROOT, martPath);
  const manifestPath = path.join(martDir, "manifest.json");
  const manifestProject = normalizeProjectPath(`${martPath}/manifest.json`);
  const artifact = {
    schema_version: "mart-refresh/v1",
    run_id: runId,
    status: dryRun ? "planned" : "refreshed",
    dataset: contract.dataset,
    created_at: new Date().toISOString(),
    mart_path: martPath,
    mart_manifest_path: dryRun ? null : manifestProject,
    hot_layer: contract.hot_layer,
    source_clean_current: cleanPublish.current_path ?? null,
    source_clean_manifest: cleanPublish.manifest_path ?? null,
    source_clean_version: cleanPublish.version_id ?? null,
    action: "write-mart-reference-manifest",
    forbidden_actions_avoided: [
      "duckdb-import-all-history",
      "production-query-entry-switch",
      "drop",
      "archive"
    ]
  };
  if (!dryRun) {
    await writeJsonUtf8Atomic(manifestPath, artifact);
  }
  await fs.mkdir(MART_REFRESH_DIR, { recursive: true });
  const artifactPath = path.join(MART_REFRESH_DIR, `${runId}.json`);
  await writeJsonUtf8Atomic(artifactPath, artifact);
  return {
    artifact,
    artifact_path: projectPath(artifactPath)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = assertDatasetName(requireArg(args, "dataset"));
  const source = assertPortableName(requireArg(args, "source"), "source");
  const tradeDate = validateTradeDate(requireArg(args, "trade-date"));
  const tradeMonth = tradeDate.slice(0, 7);
  const input = resolveProjectArg(requireArg(args, "input"), "--input");
  const scope = String(args.scope ?? "validated");
  const dryRun = args["dry-run"] === true;
  const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
  if (contract.dataset !== dataset) {
    throw new Error(`${dataset}: contract dataset mismatch`);
  }

  const runId = `sync-${dataset}-${tradeDate}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
  const steps = [];
  let status = "running";
  let stoppedAfter = null;
  let rawArtifactPath = null;
  let rawArtifact = null;
  let qualityArtifactPath = null;
  let qualityReport = null;
  let cleanArtifactPath = null;
  let cleanReport = null;
  let martRefresh = null;

  const rawArgs = [
    "--dataset", dataset,
    "--source", source,
    "--trade-date", tradeDate,
    "--scope", scope,
    "--input", input.project
  ];
  if (dryRun) rawArgs.push("--dry-run");
  const rawStarted = new Date().toISOString();
  const rawResult = await runNodeTool("raw-append.mjs", rawArgs);
  rawArtifactPath = firstJsonPath(rawResult.stdout);
  steps.push(stepRecord("raw_append", rawResult.exit_code === 0 ? "done" : "failed", {
    started_at: rawStarted,
    exit_code: rawResult.exit_code,
    artifact: rawArtifactPath,
    stdout: rawResult.stdout,
    stderr: rawResult.stderr
  }));
  if (rawResult.exit_code !== 0 || !rawArtifactPath) {
    status = "failed";
    stoppedAfter = "raw_append";
  }

  let qualityInput = input.project;
  if (status === "running") {
    rawArtifact = await readJsonUtf8(resolveProjectPath(ROOT, rawArtifactPath));
    const payloadFile = rawArtifact.metadata?.files?.find((file) => file.role === "payload")?.path;
    if (!dryRun && payloadFile) {
      qualityInput = payloadFile;
    }
    const prepStarted = new Date().toISOString();
    const prepResult = await runNodeTool("clean-partition.mjs", [
      "--dataset", dataset,
      "--trade-month", tradeMonth,
      "--row-count", "0",
      "--quality-status", "pending",
      "--quality-artifact", ".ai-coord/artifacts/data-weight-control/quality/pending.json",
      "--dry-run"
    ]);
    steps.push(stepRecord("clean_partition_prepare", prepResult.exit_code === 0 ? "done" : "failed", {
      started_at: prepStarted,
      exit_code: prepResult.exit_code,
      artifact: firstJsonPath(prepResult.stdout),
      stdout: prepResult.stdout,
      stderr: prepResult.stderr
    }));
    if (prepResult.exit_code !== 0) {
      status = "failed";
      stoppedAfter = "clean_partition_prepare";
    }
  }

  if (status === "running") {
    const qualityStarted = new Date().toISOString();
    const qualityArgs = [
      "--dataset", dataset,
      "--trade-month", tradeMonth,
      "--input", qualityInput,
      "--source-ingest-artifact", rawArtifactPath
    ];
    if (dryRun) qualityArgs.push("--dry-run");
    const qualityResult = await runNodeTool("quality-dedup.mjs", qualityArgs);
    qualityArtifactPath = firstJsonPath(qualityResult.stdout);
    steps.push(stepRecord("quality_gate", qualityResult.exit_code === 0 ? "done" : "failed", {
      started_at: qualityStarted,
      exit_code: qualityResult.exit_code,
      artifact: qualityArtifactPath,
      stdout: qualityResult.stdout,
      stderr: qualityResult.stderr
    }));
    if (qualityArtifactPath) {
      qualityReport = await readJsonUtf8(resolveProjectPath(ROOT, qualityArtifactPath));
    }
    if (qualityResult.exit_code !== 0 || !qualityReport || qualityReport.status !== "passed") {
      status = "failed";
      stoppedAfter = "quality_gate";
    }
  }

  if (status === "running") {
    const cleanStarted = new Date().toISOString();
    const cleanArgs = [
      "--dataset", dataset,
      "--trade-month", tradeMonth,
      "--row-count", String(qualityReport.output_row_count),
      "--quality-status", qualityReport.status,
      "--quality-artifact", qualityArtifactPath,
      "--source-ingest-artifact", rawArtifactPath,
      "--duplicate-key-count", String(qualityReport.duplicate_key_count),
      "--publish"
    ];
    if (qualityReport.clean_candidate_path) {
      cleanArgs.push("--data-file", qualityReport.clean_candidate_path);
    }
    if (dryRun) cleanArgs.push("--dry-run", "--allow-planned-ingest");
    const cleanResult = await runNodeTool("clean-partition.mjs", cleanArgs);
    cleanArtifactPath = firstJsonPath(cleanResult.stdout);
    steps.push(stepRecord("clean_partition_publish", cleanResult.exit_code === 0 ? "done" : "failed", {
      started_at: cleanStarted,
      exit_code: cleanResult.exit_code,
      artifact: cleanArtifactPath,
      stdout: cleanResult.stdout,
      stderr: cleanResult.stderr
    }));
    if (cleanArtifactPath) {
      cleanReport = await readJsonUtf8(resolveProjectPath(ROOT, cleanArtifactPath));
    }
    if (cleanResult.exit_code !== 0 || !cleanReport || !["published", "planned"].includes(cleanReport.status)) {
      status = "failed";
      stoppedAfter = "clean_partition_publish";
    }
  }

  if (status === "running") {
    const martStarted = new Date().toISOString();
    martRefresh = await writeMartRefreshArtifact({ runId, contract, cleanPublish: cleanReport, dryRun });
    steps.push(stepRecord("mart_refresh", "done", {
      started_at: martStarted,
      artifact: martRefresh.artifact_path,
      mart_path: martRefresh.artifact.mart_path,
      mart_manifest_path: martRefresh.artifact.mart_manifest_path
    }));
    status = "completed";
  }

  await fs.mkdir(SYNC_DIR, { recursive: true });
  const syncPath = path.join(SYNC_DIR, `${runId}.json`);
  const syncProject = projectPath(syncPath);
  const report = {
    schema_version: "daily-sync/v1",
    run_id: runId,
    status,
    dataset,
    trade_date: tradeDate,
    trade_month: tradeMonth,
    source,
    scope,
    input_path: input.project,
    dry_run: dryRun,
    started_at: steps[0]?.started_at ?? new Date().toISOString(),
    finished_at: new Date().toISOString(),
    stopped_after: stoppedAfter,
    required_order: [
      "raw_append",
      "clean_partition_prepare",
      "quality_gate",
      "clean_partition_publish",
      "mart_refresh"
    ],
    steps,
    artifacts: {
      raw_ingest: rawArtifactPath,
      quality_gate: qualityArtifactPath,
      clean_partition: cleanArtifactPath,
      mart_refresh: martRefresh?.artifact_path ?? null
    },
    sync_artifact: syncProject,
    mart_refresh_artifact: martRefresh?.artifact_path ?? null,
    forbidden_actions_avoided: [
      "full-history-rebuild",
      "unverified-production-query-entry-switch",
      "drop",
      "archive"
    ]
  };
  await writeJsonUtf8Atomic(syncPath, report);
  await fs.writeFile(path.join(SYNC_DIR, `${runId}.md`), renderMarkdown(report), "utf8");
  console.log(syncProject);
  if (martRefresh) console.log(`mart refresh: ${martRefresh.artifact_path}`);
  if (status !== "completed") process.exitCode = 2;
}

await main();
