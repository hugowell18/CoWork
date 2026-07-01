#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
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
const ARTIFACT_DIR = path.join(ROOT, ".ai-coord", "artifacts", "data-weight-control", "ingest");

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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function safeRunId(dataset, source) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  return `ingest-${dataset}-${source}-${stamp}`;
}

function projectPath(absPath) {
  return path.relative(ROOT, absPath).replaceAll(path.sep, "/");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const buffer = await fs.readFile(filePath);
  hash.update(buffer);
  return hash.digest("hex");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateDate(value, label) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return value;
}

function payloadName(inputPath) {
  const ext = path.extname(inputPath) || ".raw";
  return `payload${ext.toLowerCase()}`;
}

const args = parseArgs(process.argv.slice(2));
const dataset = assertDatasetName(requireArg(args, "dataset"));
const source = assertPortableName(requireArg(args, "source"), "source");
const inputArg = args.input && args.input !== true ? String(args.input) : null;
const tradeDateFrom = validateDate(String(args["trade-date-from"] ?? args["trade-date"] ?? todayUtc()), "trade-date-from");
const tradeDateTo = validateDate(String(args["trade-date-to"] ?? args["trade-date"] ?? tradeDateFrom), "trade-date-to");
const scopeStatus = String(args.scope ?? "provisional");
const dryRun = args["dry-run"] === true;

const contract = await readJsonUtf8(path.join(CONTRACT_DIR, `${dataset}.json`));
if (!contract.usable_scope.allowed_values.includes(scopeStatus)) {
  throw new Error(`scope ${scopeStatus} is not allowed by ${dataset} contract`);
}
const cleanAllowed = contract.usable_scope.clean_allowed.includes(scopeStatus);

const ingestRunId = args["ingest-run-id"] && args["ingest-run-id"] !== true
  ? assertPortableName(String(args["ingest-run-id"]), "ingest-run-id")
  : safeRunId(dataset, source);
const ingestDate = todayUtc();
const targetDirProject = `${contract.storage.raw_path}/source=${source}/ingest_date=${ingestDate}/ingest_run_id=${ingestRunId}`;
const targetDir = resolveProjectPath(ROOT, targetDirProject);

if (await fileExists(targetDir)) {
  throw new Error(`raw ingest target already exists; refusing to overwrite: ${targetDirProject}`);
}

let payload = null;
if (inputArg) {
  const inputPath = path.resolve(inputArg);
  const stat = await fs.stat(inputPath);
  payload = {
    source_path: inputPath,
    target_name: payloadName(inputPath),
    bytes: stat.size,
    sha256: await sha256File(inputPath)
  };
}

const metadata = {
  source,
  dataset,
  ingest_run_id: ingestRunId,
  fetch_time: new Date().toISOString(),
  trade_date_range: {
    from: tradeDateFrom,
    to: tradeDateTo
  },
  usable_scope: {
    status: scopeStatus,
    valid_from: tradeDateFrom,
    valid_to: tradeDateTo,
    reason: args.reason && args.reason !== true ? String(args.reason) : "raw ingest created by data-weight-control raw-append",
    allowed_consumers: cleanAllowed ? ["clean", "audit"] : ["audit"]
  },
  request: {
    cli: "tools/data-weight-control/raw-append.mjs",
    dry_run: dryRun
  },
  files: []
};

if (args["correction-of"] && args["correction-of"] !== true) {
  metadata.correction_of = String(args["correction-of"]);
}
if (args.supersedes && args.supersedes !== true) {
  metadata.supersedes = String(args.supersedes).split(",").map((item) => item.trim()).filter(Boolean);
}

if (payload) {
  metadata.files.push({
    path: normalizeProjectPath(`${targetDirProject}/${payload.target_name}`),
    role: "payload",
    bytes: payload.bytes,
    sha256: payload.sha256
  });
}
metadata.files.push({
  path: normalizeProjectPath(`${targetDirProject}/metadata.json`),
  role: "metadata",
  bytes: 0
});

const artifact = {
  status: dryRun ? "planned" : "written",
  target_dir: targetDirProject,
  metadata
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const artifactPath = path.join(ARTIFACT_DIR, `${ingestRunId}.json`);
await writeJsonUtf8Atomic(artifactPath, artifact);

if (!dryRun) {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.mkdir(targetDir, { recursive: false });
  if (payload) {
    await fs.copyFile(payload.source_path, path.join(targetDir, payload.target_name));
  }
  await writeJsonUtf8Atomic(path.join(targetDir, "metadata.json"), metadata);
}

console.log(projectPath(artifactPath));
if (dryRun) {
  console.log(`dry-run target: ${targetDirProject}`);
} else {
  console.log(`wrote raw ingest: ${targetDirProject}`);
}
