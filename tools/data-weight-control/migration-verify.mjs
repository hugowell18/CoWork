#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  assertDatasetName,
  normalizeProjectPath,
  readJsonUtf8,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "migration-verify");

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

function normalizeCell(value) {
  if (value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}

function normalizeDate(value) {
  const normalized = normalizeCell(value);
  if (normalized === null) return null;
  const text = String(normalized);
  if (/^[0-9]{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text)) return text.slice(0, 10);
  return text;
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

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function keyFor(row, logicalKey) {
  return JSON.stringify(logicalKey.map((field) => row[field] ?? null));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((item) => item.some((cellValue) => cellValue.trim() !== ""));
  if (!header) return [];
  const names = header.map((name) => name.trim());
  return body.map((cells) => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ""])));
}

async function readRows(inputPath, format) {
  const raw = await fs.readFile(inputPath, "utf8");
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim()
  const detected = format === "auto" ? trimmed.startsWith("[") ? "json" : firstLine.startsWith("{") ? "jsonl" : "csv" : format
  if (detected === "json") {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array");
    return parsed;
  }
  if (detected === "jsonl") return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (detected === "csv") return parseCsv(trimmed);
  throw new Error(`unsupported format ${format}`);
}

function normalizeRows(rows, contract, columns) {
  return rows.map((row) => {
    const out = {};
    for (const column of columns) {
      out[column] = column === contract.date_column ? normalizeDate(row[column]) : normalizeCell(row[column]);
    }
    return out;
  });
}

function compareKeyText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicateKeyCount(rows, logicalKey) {
  const counts = new Map();
  for (const row of rows) counts.set(keyFor(row, logicalKey), (counts.get(keyFor(row, logicalKey)) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).length;
}

function summarize(rows, contract, columns) {
  const keyed = rows.map((row) => ({ key: keyFor(row, contract.logical_key), row }));
  keyed.sort((a, b) => compareKeyText(a.key, b.key) || canonicalJson(a.row).localeCompare(canonicalJson(b.row)));
  const rowHashes = keyed.map((item) => sha256Text(canonicalJson(item.row)));
  const keySet = [...new Set(keyed.map((item) => item.key))].sort();
  const dates = rows.map((row) => row[contract.date_column]).filter(Boolean).map(String).sort();
  const nullDistribution = Object.fromEntries(columns.map((column) => [column, { null_count: 0, non_null_count: 0 }]));
  const numeric = {};
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column];
      if (value === null || value === undefined) nullDistribution[column].null_count += 1;
      else {
        nullDistribution[column].non_null_count += 1;
        const numberValue = typeof value === "number" ? value : /^-?[0-9]+(?:\.[0-9]+)?$/.test(String(value)) ? Number(value) : null;
        if (numberValue !== null && Number.isFinite(numberValue)) {
          if (!numeric[column]) numeric[column] = { count: 0, min: numberValue, max: numberValue, sum: 0 };
          numeric[column].count += 1;
          numeric[column].min = Math.min(numeric[column].min, numberValue);
          numeric[column].max = Math.max(numeric[column].max, numberValue);
          numeric[column].sum += numberValue;
        }
      }
    }
  }
  return {
    row_count: rows.length,
    key_count: keySet.length,
    key_set_sha256: sha256Text(keySet.join("\n") + (keySet.length ? "\n" : "")),
    row_checksum: sha256Text(rowHashes.join("\n") + (rowHashes.length ? "\n" : "")),
    date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : { from: null, to: null },
    duplicate_key_count: duplicateKeyCount(rows, contract.logical_key),
    null_distribution: nullDistribution,
    numeric_summaries: Object.fromEntries(Object.entries(numeric).map(([column, item]) => [column, { count: item.count, min: item.min, max: item.max, sum: Number(item.sum.toFixed(10)) }])),
    keyed_rows: keyed
  };
}

function failedSamples(sourceSummary, targetSummary) {
  const source = new Map(sourceSummary.keyed_rows.map((item) => [item.key, item.row]));
  const target = new Map(targetSummary.keyed_rows.map((item) => [item.key, item.row]));
  const keys = [...new Set([...source.keys(), ...target.keys()])].sort();
  const samples = [];
  for (const key of keys) {
    const left = source.get(key) ?? null;
    const right = target.get(key) ?? null;
    if (canonicalJson(left) !== canonicalJson(right)) samples.push({ key: JSON.parse(key), source: left, target: right });
    if (samples.length >= 10) break;
  }
  return samples;
}

async function duckdbVersion() {
  const command = process.env.DWC_DUCKDB_PATH || "duckdb";
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 10000, windowsHide: true });
    return { status: "available", command, version: stdout.trim() };
  } catch (error) {
    return { status: "unavailable", command, version: null, reason: error.message };
  }
}

function renderMarkdown(report) {
  const lines = [
    `# Migration Verify: ${report.run_id}`,
    "",
    `- status: ${report.status}`,
    `- dataset: ${report.dataset}`,
    `- window: ${report.window.id}`,
    `- mode: ${report.mode}`,
    `- row_count_match: ${report.comparisons.row_count_match}`,
    `- key_set_match: ${report.comparisons.key_set_match}`,
    `- checksum_match: ${report.comparisons.checksum_match}`,
    "",
    "## SQL",
    "",
    "```sql",
    report.verification_sql,
    "```",
    "",
    "## Conclusion",
    "",
    report.failures.length ? report.failures.map((item) => `- ${item}`).join("\n") : "- passed"
  ];
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const sourceRef = optionalString(args, "source") ? resolveProjectArg(optionalString(args, "source"), "--source") : null;
const targetRef = optionalString(args, "target") ? resolveProjectArg(optionalString(args, "target"), "--target") : null;
const format = String(args.format ?? "auto");
if (!["auto", "json", "jsonl", "csv"].includes(format)) throw new Error("--format must be auto, json, jsonl, or csv");
const windowId = optionalString(args, "window-id") ?? "explicit-window";
const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
if (contract.dataset !== dataset) throw new Error(`${dataset}: contract dataset mismatch`);
const runId = `migration-verify-${dataset}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const artifactPath = path.join(ARTIFACT_DIR, `${runId}.json`);
const artifactProject = projectPath(artifactPath);
const duckdb = await duckdbVersion();

let report;
if (!sourceRef || !targetRef) {
  report = {
    schema_version: "migration-verify/v1",
    run_id: runId,
    status: "blocked",
    dataset,
    mode: "blocked-missing-input",
    created_at: new Date().toISOString(),
    duckdb,
    window: { id: windowId, source: sourceRef?.project ?? null, target: targetRef?.project ?? null },
    verification_sql: "-- blocked: source and target inputs are required before query entry switching",
    source_summary: null,
    target_summary: null,
    comparisons: { row_count_match: false, key_set_match: false, checksum_match: false, date_range_match: false, duplicate_key_count_match: false },
    failed_samples: [],
    failures: ["missing source or target verification input"],
    forbidden_actions_avoided: ["drop", "archive", "production-query-entry-switch"]
  };
} else {
  const sourceRowsRaw = await readRows(sourceRef.absolute, format);
  const targetRowsRaw = await readRows(targetRef.absolute, format);
  const columns = [...new Set([...sourceRowsRaw.flatMap((row) => Object.keys(row)), ...targetRowsRaw.flatMap((row) => Object.keys(row))])].sort();
  const sourceRows = normalizeRows(sourceRowsRaw, contract, columns);
  const targetRows = normalizeRows(targetRowsRaw, contract, columns);
  const sourceSummary = summarize(sourceRows, contract, columns);
  const targetSummary = summarize(targetRows, contract, columns);
  const comparisons = {
    row_count_match: sourceSummary.row_count === targetSummary.row_count,
    key_set_match: sourceSummary.key_set_sha256 === targetSummary.key_set_sha256,
    checksum_match: sourceSummary.row_checksum === targetSummary.row_checksum,
    date_range_match: canonicalJson(sourceSummary.date_range) === canonicalJson(targetSummary.date_range),
    duplicate_key_count_match: sourceSummary.duplicate_key_count === targetSummary.duplicate_key_count
  };
  const failures = Object.entries(comparisons).filter(([, passed]) => !passed).map(([name]) => name.replace(/_match$/, " mismatch"))
  if (!failures.length && duckdb.status !== "available") {
    failures.push("verification engine unavailable: cannot authorize entry switch/drop")
  }
  const status = failures.length ? failures.some((item) => item.endsWith("mismatch")) ? "failed" : "blocked" : "passed"
  report = {
    schema_version: "migration-verify/v1",
    run_id: runId,
    status,
    dataset,
    mode: status === "blocked" ? "blocked-engine-unavailable-fixture-rehearsal" : "cross-engine-canonical-fixture",
    created_at: new Date().toISOString(),
    duckdb,
    window: { id: windowId, source: sourceRef.project, target: targetRef.project },
    verification_sql: `-- canonical fixture verification for ${dataset}\n-- DuckDB unavailable in this environment is recorded separately.\n-- Production mode must run equivalent SELECTs against source table and target Parquet view in one DuckDB connection.`,
    columns,
    logical_key: contract.logical_key,
    date_column: contract.date_column,
    source_summary: { ...sourceSummary, keyed_rows: undefined },
    target_summary: { ...targetSummary, keyed_rows: undefined },
    comparisons,
    failed_samples: status === "failed" ? failedSamples(sourceSummary, targetSummary) : [],
    failures,
    conclusion: status,
    forbidden_actions_avoided: ["drop", "archive", "production-query-entry-switch"]
  };
}

await writeJsonUtf8Atomic(artifactPath, report);
await fs.writeFile(path.join(ARTIFACT_DIR, `${runId}.md`), renderMarkdown(report), "utf8");
console.log(artifactProject);
if (report.status !== "passed") process.exitCode = report.status === "blocked" ? 2 : 1;
