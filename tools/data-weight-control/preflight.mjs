#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readJsonUtf8,
  resolveProjectPath,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "preflight");
const LOCKS_DIR = path.join(ROOT, ".ai-coord", "locks");
const RUN_ID = `preflight-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const DATE_COLUMN_CANDIDATES = [
  "trade_date",
  "trade_time",
  "date",
  "datetime",
  "timestamp",
  "ts"
];
const LARGE_TABLE_ROW_THRESHOLD = 1_000_000;

function projectPath(absPath) {
  return path.relative(ROOT, absPath).replaceAll(path.sep, "/");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runDuckDbJson(dbPath, sql) {
  const { stdout } = await execFileAsync("duckdb", [
    dbPath,
    "-json",
    "-c",
    sql
  ], { timeout: 30000 });
  return JSON.parse(stdout || "[]");
}

async function duckDbVersion() {
  try {
    const { stdout } = await execFileAsync("duckdb", ["--version"], { timeout: 10000 });
    return {
      status: "available",
      version: stdout.trim()
    };
  } catch (error) {
    return {
      status: "unavailable",
      version: null,
      reason: error.message
    };
  }
}

async function listJsonContracts() {
  const names = await fs.readdir(CONTRACT_DIR);
  return names
    .filter((name) => name.endsWith(".json") && name !== "schema.json")
    .sort();
}

async function readLocks() {
  try {
    const names = await fs.readdir(LOCKS_DIR);
    const locks = [];
    for (const name of names.filter((item) => item.endsWith(".lock.json")).sort()) {
      const filePath = path.join(LOCKS_DIR, name);
      try {
        const lock = await readJsonUtf8(filePath);
        const expiresAt = lock.expires_at ? new Date(lock.expires_at) : null;
        locks.push({
          file: projectPath(filePath),
          resource: lock.resource,
          owner: lock.owner,
          expires_at: lock.expires_at ?? null,
          expired: expiresAt ? expiresAt.getTime() <= Date.now() : false,
          reason: lock.reason ?? null
        });
      } catch (error) {
        locks.push({
          file: projectPath(filePath),
          error: error.message
        });
      }
    }
    return locks;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function activeLockFor(locks, resource) {
  return locks.find((lock) => lock.resource === resource && !lock.expired && !lock.error);
}

async function collectParquetFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".parquet")) {
        const stat = await fs.stat(full);
        files.push({ path: full, bytes: stat.size });
      }
    }
  }
  await walk(dir);
  return files;
}

async function latestMtimeUnder(dir, predicate = () => true) {
  let latest = null;
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        const stat = await fs.stat(full);
        if (!latest || stat.mtimeMs > latest.mtime_ms) {
          latest = {
            path: projectPath(full),
            mtime: stat.mtime.toISOString(),
            mtime_ms: stat.mtimeMs
          };
        }
      }
    }
  }
  await walk(dir);
  return latest;
}

async function findQualityArtifacts(dataset) {
  const qualityDir = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "quality");
  const latest = await latestMtimeUnder(qualityDir, (name) => name.endsWith(".json") || name.endsWith(".md"));
  return latest
    ? {
        status: "found",
        latest_artifact: latest
      }
    : {
        status: "not-found",
        latest_artifact: null,
        dataset
      };
}

async function inspectSmallFiles(contract) {
  const cleanRoot = resolveProjectPath(ROOT, contract.storage.clean_path);
  const exists = await fileExists(cleanRoot);
  if (!exists) {
    return {
      clean_path: contract.storage.clean_path,
      status: "not-found",
      candidate: false,
      months: []
    };
  }

  const entries = await fs.readdir(cleanRoot, { withFileTypes: true });
  const months = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.includes("=")).sort((a, b) => a.name.localeCompare(b.name))) {
    const monthDir = path.join(cleanRoot, entry.name);
    const parquetFiles = await collectParquetFiles(monthDir);
    const fileCount = parquetFiles.length;
    const totalBytes = parquetFiles.reduce((sum, file) => sum + file.bytes, 0);
    const averageMb = fileCount ? totalBytes / fileCount / 1024 / 1024 : 0;
    const overCount = fileCount > contract.small_file.max_files_per_month;
    const tooSmall = fileCount > 0 && averageMb < contract.small_file.min_average_file_mb;
    months.push({
      partition: entry.name,
      file_count: fileCount,
      average_file_mb: Number(averageMb.toFixed(3)),
      candidate: overCount || tooSmall,
      reason: overCount
        ? "file-count-over-threshold"
        : tooSmall
          ? "average-file-size-under-threshold"
          : "ok"
    });
  }

  return {
    clean_path: contract.storage.clean_path,
    status: "ok",
    candidate: months.some((month) => month.candidate),
    thresholds: contract.small_file,
    months
  };
}

async function inspectIncrementalSync(contract) {
  const rawRoot = resolveProjectPath(ROOT, contract.storage.raw_path);
  const cleanRoot = resolveProjectPath(ROOT, contract.storage.clean_path);
  const martRoot = contract.storage.mart_path ? resolveProjectPath(ROOT, contract.storage.mart_path) : null;
  const latestRawMetadata = await latestMtimeUnder(rawRoot, (name) => name === "metadata.json");
  const latestQuality = await findQualityArtifacts(contract.dataset);
  const latestMartFile = martRoot ? await latestMtimeUnder(martRoot, (name) => name.endsWith(".parquet") || name.endsWith(".json")) : null;
  const cleanExists = await fileExists(cleanRoot);
  const martExists = martRoot ? await fileExists(martRoot) : false;

  const observations = [];
  if (!latestRawMetadata) observations.push("no-raw-ingest-metadata-found");
  if (latestQuality.status === "not-found") observations.push("no-quality-artifact-found");
  if (!martExists) observations.push("mart-path-not-found");
  if (!cleanExists) observations.push("clean-path-not-found");

  return {
    dataset: contract.dataset,
    mode: "observe-only",
    expected_default_scope: "today-or-gap-dates",
    full_history_rebuild_allowed: false,
    latest_raw_metadata: latestRawMetadata,
    latest_quality_artifact: latestQuality.latest_artifact,
    latest_mart_file: latestMartFile,
    clean_path_status: cleanExists ? "found" : "not-found",
    mart_path_status: martExists ? "found" : "not-found",
    suspected_full_history_refresh_risk: false,
    duplicate_key_check: "not-evaluated-without-clean-data",
    gap_date_check: "not-evaluated-without-trade-calendar-or-clean-data",
    old_data_residue_check: "not-evaluated-without-clean-data",
    conclusion: observations.length ? "warn" : "pass",
    observations
  };
}

async function inspectDuckDb(locks) {
  const version = await duckDbVersion();
  const duckdbLock = activeLockFor(locks, "duckdb");
  if (duckdbLock && duckdbLock.owner !== "codex") {
    return {
      status: "locked-by-other",
      version,
      lock: duckdbLock,
      tables: []
    };
  }

  const dbPath = process.env.DWC_DUCKDB_PATH;
  if (!dbPath) {
    return {
      status: "not-configured",
      env: "DWC_DUCKDB_PATH",
      version,
      tables: []
    };
  }

  const resolved = path.resolve(dbPath);
  if (!(await fileExists(resolved))) {
    return {
      status: "configured-path-not-found",
      env: "DWC_DUCKDB_PATH",
      path: dbPath,
      version,
      tables: []
    };
  }

  try {
    const rows = await runDuckDbJson(
      resolved,
      "select table_name from information_schema.tables where table_schema = 'main' and table_type = 'BASE TABLE' order by table_name"
    );
    const tables = [];
    for (const row of rows) {
      tables.push(await inspectDuckDbTable(resolved, row.table_name));
    }
    return {
      status: "available",
      path: dbPath,
      version,
      tables
    };
  } catch (error) {
    return {
      status: "duckdb-cli-unavailable-or-query-failed",
      path: dbPath,
      version,
      error: error.message,
      tables: []
    };
  }
}

async function inspectDuckDbTable(dbPath, tableName) {
  try {
    const columns = await runDuckDbJson(
      dbPath,
      `select column_name, data_type from information_schema.columns where table_schema = 'main' and table_name = ${sqlLiteral(tableName)} order by ordinal_position`
    );
    const columnNames = columns.map((column) => column.column_name);
    const dateColumn = DATE_COLUMN_CANDIDATES.find((candidate) => columnNames.includes(candidate))
      ?? columnNames.find((name) => /date|time|timestamp|datetime/i.test(name))
      ?? null;
    const rowCountRows = await runDuckDbJson(dbPath, `select count(*)::ubigint as row_count from ${quoteIdent(tableName)}`);
    const rowCount = Number(rowCountRows[0]?.row_count ?? 0);
    let dateCoverage = null;
    if (dateColumn) {
      const dateRows = await runDuckDbJson(
        dbPath,
        `select min(${quoteIdent(dateColumn)})::varchar as min_date, max(${quoteIdent(dateColumn)})::varchar as max_date from ${quoteIdent(tableName)}`
      );
      dateCoverage = {
        date_column: dateColumn,
        min_date: dateRows[0]?.min_date ?? null,
        max_date: dateRows[0]?.max_date ?? null,
        latest_date: dateRows[0]?.max_date ?? null
      };
    }
    return {
      table_name: tableName,
      row_count: rowCount,
      date_column: dateColumn,
      date_coverage: dateCoverage,
      suspected_partition_key: dateColumn,
      large_table: rowCount >= LARGE_TABLE_ROW_THRESHOLD,
      growth_risk: rowCount >= LARGE_TABLE_ROW_THRESHOLD ? "large-row-count" : "none",
      columns: columns.map((column) => ({
        name: column.column_name,
        type: column.data_type
      }))
    };
  } catch (error) {
    return {
      table_name: tableName,
      status: "warn",
      error: error.message
    };
  }
}

function datasetRisk(contract, smallFiles) {
  const reasons = [];
  if (contract.migration.candidate) reasons.push(contract.migration.candidate_reason ?? "contract-migration-candidate");
  if (smallFiles.candidate) reasons.push("small-file-compaction-candidate");
  if (contract.strategy_risks.length) reasons.push(...contract.strategy_risks.map((risk) => `strategy-risk:${risk}`));
  return {
    dataset: contract.dataset,
    hot_layer: contract.hot_layer,
    migration_candidate: contract.migration.candidate || smallFiles.candidate,
    migration_candidate_reasons: reasons,
    small_files: smallFiles
  };
}

function pathChecks(contracts) {
  const paths = [];
  for (const contract of contracts) {
    for (const key of ["raw_path", "clean_path", "mart_path"]) {
      const relative = contract.storage[key];
      if (!relative) continue;
      paths.push({
        dataset: contract.dataset,
        kind: key,
        project_path: relative,
        runtime_path: resolveProjectPath(ROOT, relative)
      });
    }
  }
  for (const [kind, relative] of [
    ["artifact_preflight", ".ai-coord/artifacts/data-weight-control/preflight"],
    ["artifact_execution", ".ai-coord/artifacts/data-weight-control/execution"],
    ["artifact_impl_review", ".ai-coord/artifacts/data-weight-control/impl-review"]
  ]) {
    paths.push({
      dataset: null,
      kind,
      project_path: relative,
      runtime_path: resolveProjectPath(ROOT, relative)
    });
  }
  return paths;
}

function renderMarkdown(report) {
  const lines = [
    `# Preflight Report: ${report.run_id}`,
    "",
    `Conclusion: ${report.conclusion}`,
    "",
    "## Platform",
    "",
    `- platform: ${report.platform.platform}`,
    `- node: ${report.platform.node}`,
    `- project_root: ${report.platform.project_root}`,
    `- duckdb: ${report.tools.duckdb.version ?? "unavailable"}`,
    "",
    "## Paths",
    ""
  ];
  for (const item of report.paths) {
    lines.push(`- ${item.kind}${item.dataset ? ` (${item.dataset})` : ""}: ${item.project_path} -> ${item.runtime_path}`);
  }
  lines.push(
    "",
    "## DuckDB",
    "",
    `- status: ${report.duckdb.status}`
  );
  if (report.duckdb.lock) {
    lines.push(`- lock: ${report.duckdb.lock.resource} owner=${report.duckdb.lock.owner}`);
  }
  if (report.duckdb.error) {
    lines.push(`- error: ${report.duckdb.error}`);
  }
  lines.push("", "## Datasets", "");
  for (const dataset of report.datasets) {
    lines.push(`### ${dataset.dataset}`, "");
    lines.push(`- hot_layer: ${dataset.hot_layer.mode}${dataset.hot_layer.window_days ? ` ${dataset.hot_layer.window_days}d` : ""}`);
    lines.push(`- migration_candidate: ${dataset.migration_candidate}`);
    lines.push(`- reasons: ${dataset.migration_candidate_reasons.length ? dataset.migration_candidate_reasons.join(", ") : "none"}`);
    lines.push(`- small_file_status: ${dataset.small_files.status}`);
    if (dataset.small_files.months?.length) {
      for (const month of dataset.small_files.months) {
        lines.push(`  - ${month.partition}: files=${month.file_count}, avg_mb=${month.average_file_mb}, candidate=${month.candidate}`);
      }
    }
    lines.push("");
  }
  lines.push("## Incremental Sync", "");
  for (const item of report.incremental_sync) {
    lines.push(`### ${item.dataset}`, "");
    lines.push(`- mode: ${item.mode}`);
    lines.push(`- default_scope: ${item.expected_default_scope}`);
    lines.push(`- full_history_rebuild_allowed: ${item.full_history_rebuild_allowed}`);
    lines.push(`- conclusion: ${item.conclusion}`);
    lines.push(`- observations: ${item.observations.length ? item.observations.join(", ") : "none"}`);
    lines.push(`- latest_raw_metadata: ${item.latest_raw_metadata?.path ?? "none"}`);
    lines.push(`- latest_quality_artifact: ${item.latest_quality_artifact?.path ?? "none"}`);
    lines.push(`- latest_mart_file: ${item.latest_mart_file?.path ?? "none"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const locks = await readLocks();
const contracts = [];
for (const name of await listJsonContracts()) {
  contracts.push(await readJsonUtf8(path.join(CONTRACT_DIR, name)));
}

const duckdb = await inspectDuckDb(locks);
const datasets = [];
const incrementalSync = [];
for (const contract of contracts) {
  const smallFiles = await inspectSmallFiles(contract);
  datasets.push(datasetRisk(contract, smallFiles));
  incrementalSync.push(await inspectIncrementalSync(contract));
}
const paths = pathChecks(contracts);

const conclusion = duckdb.status === "locked-by-other"
  ? "blocked"
  : datasets.some((dataset) => dataset.migration_candidate) || incrementalSync.some((item) => item.conclusion === "warn")
    ? "warn"
    : "pass";

const report = {
  run_id: RUN_ID,
  generated_at: new Date().toISOString(),
  conclusion,
  platform: {
    platform: process.platform,
    node: process.version,
    project_root: ROOT
  },
  tools: {
    node: process.version,
    duckdb: duckdb.version
  },
  paths,
  locks,
  duckdb,
  datasets,
  incremental_sync: incrementalSync
};

const jsonPath = path.join(ARTIFACT_DIR, `${RUN_ID}.json`);
const mdPath = path.join(ARTIFACT_DIR, `${RUN_ID}.md`);
await writeJsonUtf8Atomic(jsonPath, report);
await fs.mkdir(ARTIFACT_DIR, { recursive: true });
await fs.writeFile(mdPath, renderMarkdown(report), "utf8");

console.log(projectPath(jsonPath));
console.log(projectPath(mdPath));
