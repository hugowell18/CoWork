#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertDatasetName,
  normalizeProjectPath,
  readJsonUtf8
} from "./lib/project-paths.mjs";

const ROOT = process.cwd();
const CONTRACT_DIR = path.join(ROOT, "metadata", "dataset-contracts");
const REQUIRED_SCOPES = ["provisional", "validated", "corrected", "rejected"];

function assertArray(value, label, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw new Error(`${label} must be an array with at least ${min} item(s)`);
  }
}

function assertLowerArray(value, label) {
  assertArray(value, label);
  for (const item of value) {
    if (typeof item !== "string" || item !== item.toLowerCase()) {
      throw new Error(`${label} contains a non-lowercase string: ${item}`);
    }
  }
}

function assertPortablePaths(contract) {
  for (const key of ["raw_path", "clean_path", "mart_path"]) {
    if (contract.storage[key]) {
      normalizeProjectPath(contract.storage[key]);
    }
  }
}

function validateContract(contract, fileName) {
  assertDatasetName(contract.dataset);
  if (fileName !== `${contract.dataset}.json`) {
    throw new Error(`${fileName} must match dataset name ${contract.dataset}.json`);
  }
  assertLowerArray(contract.logical_key, "logical_key");
  assertLowerArray(contract.sort_order, "sort_order");
  if (!contract.logical_key.includes(contract.date_column) && contract.date_column !== "trade_date") {
    throw new Error(`${contract.dataset}: date_column must be part of logical_key or be trade_date`);
  }
  if (contract.partition?.type !== "month" || contract.partition?.format !== "YYYY-MM") {
    throw new Error(`${contract.dataset}: partition must be monthly with YYYY-MM format`);
  }
  if (contract.dedup?.on_unresolved_tie !== "block") {
    throw new Error(`${contract.dataset}: unresolved dedup ties must block`);
  }
  assertArray(contract.dedup?.order_by, "dedup.order_by");
  const scopes = contract.usable_scope?.allowed_values ?? [];
  for (const scope of REQUIRED_SCOPES) {
    if (!scopes.includes(scope)) {
      throw new Error(`${contract.dataset}: usable_scope.allowed_values missing ${scope}`);
    }
  }
  if (contract.usable_scope.clean_allowed.includes("rejected")) {
    throw new Error(`${contract.dataset}: rejected scope must not enter clean`);
  }
  if (contract.hot_layer?.mode === "rolling-window" && !Number.isInteger(contract.hot_layer.window_days)) {
    throw new Error(`${contract.dataset}: rolling-window hot layer requires window_days`);
  }
  assertPortablePaths(contract);
  if (!contract.migration?.requires_human_approval_to_drop) {
    throw new Error(`${contract.dataset}: drop must require human approval`);
  }
}

const files = (await fs.readdir(CONTRACT_DIR))
  .filter((name) => name.endsWith(".json") && name !== "schema.json")
  .sort();

if (!files.length) {
  throw new Error("no dataset contract files found");
}

for (const fileName of files) {
  const contract = await readJsonUtf8(path.join(CONTRACT_DIR, fileName));
  validateContract(contract, fileName);
  console.log(`ok ${fileName}`);
}

console.log(`validated ${files.length} dataset contract(s)`);
