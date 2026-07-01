#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertDatasetName,
  normalizeProjectPath,
  readJsonUtf8,
  writeJsonUtf8Atomic
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "quality");

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
  return { absolute, project: persisted };
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
  if (/^[0-9]{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text)) {
    return text.slice(0, 10);
  }
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

function keyFor(row, fields) {
  return JSON.stringify(fields.map((field) => row[field] ?? null));
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRowsByFieldValues(left, right, fields) {
  for (const field of fields) {
    const comparison = compareValues(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareRowsByFields(left, right, fields) {
  const fieldComparison = compareRowsByFieldValues(left, right, fields);
  if (fieldComparison !== 0) return fieldComparison;
  const fallback = canonicalJson(left).localeCompare(canonicalJson(right));
  return fallback < 0 ? -1 : fallback > 0 ? 1 : 0;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((item) => item.some((cellValue) => cellValue.trim() !== ""));
  if (!header) return [];
  const names = header.map((name) => String(name).trim());
  return body.map((cells) => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ""])));
}

async function readRows(inputPath, format) {
  const raw = await fs.readFile(inputPath, "utf8");
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  const detected = format === "auto"
    ? trimmed.startsWith("[") ? "json" : trimmed.includes(",") && trimmed.includes("\n") ? "csv" : "jsonl"
    : format;
  if (detected === "json") {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array of objects");
    return parsed;
  }
  if (detected === "jsonl") {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  if (detected === "csv") {
    return parseCsv(trimmed);
  }
  throw new Error(`unsupported --format ${format}`);
}

async function readSourceIngestArtifacts(dataset, sourceArtifactArgs, { allowPlannedIngest = false } = {}) {
  const validations = [];
  const sources = [];
  for (const input of sourceArtifactArgs) {
    const ref = resolveProjectArg(input, "--source-ingest-artifact");
    const artifact = await readJsonUtf8(ref.absolute);
    const metadata = artifact.metadata ?? {};
    const cleanAllowed = metadata.usable_scope?.allowed_consumers?.includes("clean") === true;
    const written = artifact.status === "written" || (allowPlannedIngest && artifact.status === "planned");
    const datasetMatches = metadata.dataset === dataset;
    const validation = {
      ingest_artifact: ref.project,
      status: artifact.status ?? null,
      dataset: metadata.dataset ?? null,
      ingest_run_id: metadata.ingest_run_id ?? null,
      clean_allowed: cleanAllowed,
      written,
      dataset_matches: datasetMatches,
      passed: cleanAllowed && written && datasetMatches
    };
    validations.push(validation);
    sources.push({
      source: metadata.source ?? null,
      ingest_run_id: metadata.ingest_run_id ?? null,
      fetch_time: metadata.fetch_time ?? null,
      usable_scope: metadata.usable_scope ?? null,
      trade_date_range: metadata.trade_date_range ?? null,
      ingest_artifact: ref.project,
      artifact_status: artifact.status ?? null,
      raw_metadata_path: metadata.files?.find((file) => file.role === "metadata")?.path ?? null
    });
  }
  return { validations, sources };
}

function normalizeRows(rows, contract, sources) {
  const singleSource = sources.length === 1 ? sources[0] : null;
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("all input rows must be objects");
    }
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = key === contract.date_column ? normalizeDate(value) : normalizeCell(value);
    }
    if (singleSource) {
      if (out.fetch_time === undefined || out.fetch_time === null) out.fetch_time = singleSource.fetch_time;
      if (out.ingest_run_id === undefined || out.ingest_run_id === null) out.ingest_run_id = singleSource.ingest_run_id;
    }
    if (out[contract.date_column] !== undefined) {
      out[contract.date_column] = normalizeDate(out[contract.date_column]);
    }
    return out;
  });
}

function analyzeRows(rows, contract, tradeMonth) {
  const failures = [];
  const missingKeyRows = [];
  const missingOrderRows = [];
  const outOfMonthRows = [];
  const allColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const null_distribution = Object.fromEntries(allColumns.map((column) => [column, { null_count: 0, non_null_count: 0 }]));
  const numeric = {};
  const dates = [];

  for (const [index, row] of rows.entries()) {
    const missingKey = contract.logical_key.filter((field) => row[field] === null || row[field] === undefined);
    if (missingKey.length) {
      missingKeyRows.push({ row_index: index, missing_fields: missingKey, sample: row });
    }
    const missingOrder = contract.dedup.order_by.filter((field) => row[field] === null || row[field] === undefined);
    if (missingOrder.length) {
      missingOrderRows.push({ row_index: index, missing_fields: missingOrder, sample: row });
    }
    const dateValue = row[contract.date_column];
    if (dateValue === null || dateValue === undefined || String(dateValue).slice(0, 7) !== tradeMonth) {
      outOfMonthRows.push({ row_index: index, value: dateValue ?? null, sample: row });
    } else {
      dates.push(String(dateValue));
    }
    for (const column of allColumns) {
      const value = row[column];
      if (value === null || value === undefined) {
        null_distribution[column].null_count += 1;
      } else {
        null_distribution[column].non_null_count += 1;
        const numericValue = typeof value === "number" ? value : /^-?[0-9]+(?:\.[0-9]+)?$/.test(String(value)) ? Number(value) : null;
        if (numericValue !== null && Number.isFinite(numericValue)) {
          if (!numeric[column]) numeric[column] = { count: 0, min: numericValue, max: numericValue, sum: 0 };
          numeric[column].count += 1;
          numeric[column].min = Math.min(numeric[column].min, numericValue);
          numeric[column].max = Math.max(numeric[column].max, numericValue);
          numeric[column].sum += numericValue;
        }
      }
    }
  }

  if (contract.dedup?.mode !== "last-write-wins") {
    failures.push(`unsupported dedup mode: ${contract.dedup?.mode}`);
  }
  if (missingKeyRows.length) failures.push("missing logical key values");
  if (missingOrderRows.length) failures.push("missing dedup order values");
  if (outOfMonthRows.length) failures.push("rows outside target trade month or missing date");

  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row, contract.logical_key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const winners = [];
  const duplicateSamples = [];
  const tieSamples = [];
  let duplicateKeyCount = 0;
  let duplicateRowCount = 0;
  for (const [key, group] of groups.entries()) {
    if (group.length === 1) {
      winners.push(group[0]);
      continue;
    }
    duplicateKeyCount += 1;
    duplicateRowCount += group.length;
    const ordered = [...group].sort((left, right) => compareRowsByFieldValues(left, right, contract.dedup.order_by));
    const winner = ordered[ordered.length - 1];
    const topTies = ordered.filter((row) => compareRowsByFieldValues(row, winner, contract.dedup.order_by) === 0);
    const exactTie = topTies.every((row) => canonicalJson(row) === canonicalJson(winner));
    duplicateSamples.push({
      key: JSON.parse(key),
      row_count: group.length,
      winner_order: Object.fromEntries(contract.dedup.order_by.map((field) => [field, winner[field] ?? null])),
      sample_rows: group.slice(0, 3)
    });
    if (topTies.length > 1 && !exactTie) {
      tieSamples.push({
        key: JSON.parse(key),
        tied_rows: topTies.slice(0, 3)
      });
      continue;
    }
    winners.push(winner);
  }
  if (tieSamples.length) failures.push("unresolved duplicate key tie");

  const sortedWinners = winners.sort((left, right) => compareRowsByFields(left, right, contract.sort_order));
  const dateRange = dates.length
    ? { from: dates.sort()[0], to: dates.sort()[dates.length - 1] }
    : { from: null, to: null };
  const numeric_summaries = Object.fromEntries(Object.entries(numeric).map(([column, item]) => [
    column,
    {
      count: item.count,
      min: item.min,
      max: item.max,
      sum: Number(item.sum.toFixed(10))
    }
  ]));

  return {
    failures,
    rows: sortedWinners,
    input_row_count: rows.length,
    output_row_count: sortedWinners.length,
    duplicate_key_count: duplicateKeyCount,
    duplicate_row_count: duplicateRowCount,
    duplicate_samples: duplicateSamples.slice(0, 10),
    unresolved_tie_count: tieSamples.length,
    unresolved_tie_samples: tieSamples.slice(0, 10),
    missing_key_count: missingKeyRows.length,
    missing_key_samples: missingKeyRows.slice(0, 10),
    missing_order_count: missingOrderRows.length,
    missing_order_samples: missingOrderRows.slice(0, 10),
    out_of_month_count: outOfMonthRows.length,
    out_of_month_samples: outOfMonthRows.slice(0, 10),
    date_range: dateRange,
    null_distribution,
    numeric_summaries
  };
}

function jsonlForRows(rows) {
  return rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
}

function renderMarkdown(report) {
  const lines = [
    `# Quality Gate: ${report.run_id}`,
    "",
    `- status: ${report.status}`,
    `- dataset: ${report.dataset}`,
    `- partition: ${report.partition_id}`,
    `- input_rows: ${report.input_row_count}`,
    `- output_rows: ${report.output_row_count}`,
    `- duplicate_key_count: ${report.duplicate_key_count}`,
    `- unresolved_tie_count: ${report.unresolved_tie_count}`,
    `- clean_candidate: ${report.clean_candidate_path ?? "not-written"}`,
    "",
    "## Conclusion",
    "",
    report.failures.length ? report.failures.map((item) => `- ${item}`).join("\n") : "- passed",
    "",
    "## Dedup",
    "",
    `- strategy: ${report.dedup_strategy}`,
    `- order_by: ${report.dedup_order_by.join(", ")}`,
    `- duplicate_rows: ${report.duplicate_row_count}`,
    "",
    "## Date Range",
    "",
    `- from: ${report.date_range.from ?? "none"}`,
    `- to: ${report.date_range.to ?? "none"}`,
    `- out_of_month_count: ${report.out_of_month_count}`,
    ""
  ];
  if (report.duplicate_samples.length) {
    lines.push("## Duplicate Samples", "");
    for (const sample of report.duplicate_samples.slice(0, 5)) {
      lines.push(`- key=${JSON.stringify(sample.key)} rows=${sample.row_count}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const tradeMonth = validateTradeMonth(requireArg(args, "trade-month"));
const input = resolveProjectArg(requireArg(args, "input"), "--input");
const format = String(args.format ?? "auto");
if (!["auto", "json", "jsonl", "csv"].includes(format)) {
  throw new Error("--format must be one of auto, json, jsonl, csv");
}
const dryRun = args["dry-run"] === true;
if (args["allow-planned-ingest"] === true && !dryRun) {
  throw new Error("--allow-planned-ingest is only valid with --dry-run");
}
const allowPlannedIngest = dryRun || args["allow-planned-ingest"] === true;
const writeCleanCandidate = args["no-clean-candidate"] !== true && !dryRun;
const sourceArgs = valuesOf(args, "source-ingest-artifact");
if (!dryRun && !sourceArgs.length) {
  throw new Error("missing required argument --source-ingest-artifact for non-dry-run quality gates");
}

const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
if (contract.dataset !== dataset) {
  throw new Error(`${dataset}: contract dataset mismatch`);
}

const rawRows = await readRows(input.absolute, format);
const { validations: source_validations, sources } = await readSourceIngestArtifacts(dataset, sourceArgs, { allowPlannedIngest });
const normalizedRows = normalizeRows(rawRows, contract, sources);
const analysis = analyzeRows(normalizedRows, contract, tradeMonth);
const sourceFailures = source_validations.filter((item) => !item.passed).map((item) => `source ingest not clean-eligible: ${item.ingest_artifact}`);
const missingSourceFailure = sourceArgs.length || dryRun ? [] : ["missing source ingest artifact"];
const failures = [...missingSourceFailure, ...sourceFailures, ...analysis.failures];
const status = failures.length ? "failed" : "passed";
const partitionId = `${contract.partition.column === "trade_date" ? "trade_month" : `${contract.partition.column}_month`}=${tradeMonth}`;
const runId = `quality-${dataset}-${tradeMonth}-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`;
const cleanCandidatePath = path.join(ARTIFACT_DIR, `${runId}-clean.jsonl`);
const cleanCandidateProject = projectPath(cleanCandidatePath);
const candidateBody = jsonlForRows(analysis.rows);
const candidateChecksum = sha256Text(candidateBody);

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
if (status === "passed" && writeCleanCandidate) {
  await fs.writeFile(cleanCandidatePath, candidateBody, "utf8");
}

const report = {
  schema_version: "quality-gate/v1",
  run_id: runId,
  status,
  dataset,
  partition_id: partitionId,
  trade_month: tradeMonth,
  created_at: new Date().toISOString(),
  input_path: input.project,
  input_format: format,
  source_ingest_runs: sources,
  source_validations,
  logical_key: contract.logical_key,
  date_column: contract.date_column,
  dedup_strategy: contract.dedup.mode,
  dedup_order_by: contract.dedup.order_by,
  sort_order: contract.sort_order,
  input_row_count: analysis.input_row_count,
  output_row_count: analysis.output_row_count,
  duplicate_key_count: analysis.duplicate_key_count,
  duplicate_row_count: analysis.duplicate_row_count,
  duplicate_samples: analysis.duplicate_samples,
  unresolved_tie_count: analysis.unresolved_tie_count,
  unresolved_tie_samples: analysis.unresolved_tie_samples,
  missing_key_count: analysis.missing_key_count,
  missing_key_samples: analysis.missing_key_samples,
  missing_order_count: analysis.missing_order_count,
  missing_order_samples: analysis.missing_order_samples,
  out_of_month_count: analysis.out_of_month_count,
  out_of_month_samples: analysis.out_of_month_samples,
  date_range: analysis.date_range,
  null_distribution: analysis.null_distribution,
  numeric_summaries: analysis.numeric_summaries,
  gap_date_check: "not-evaluated-without-trade-calendar",
  old_data_residue_check: "not-evaluated-without-current-clean-pointer",
  clean_candidate_path: status === "passed" && writeCleanCandidate ? cleanCandidateProject : null,
  clean_candidate_sha256: status === "passed" && writeCleanCandidate ? candidateChecksum : null,
  failures,
  conclusion: status
};

const reportJson = path.join(ARTIFACT_DIR, `${runId}.json`);
const reportMd = path.join(ARTIFACT_DIR, `${runId}.md`);
await writeJsonUtf8Atomic(reportJson, report);
await fs.writeFile(reportMd, renderMarkdown(report), "utf8");

console.log(projectPath(reportJson));
if (report.clean_candidate_path) {
  console.log(`clean candidate: ${report.clean_candidate_path}`);
}
if (status !== "passed") {
  process.exitCode = 2;
}
