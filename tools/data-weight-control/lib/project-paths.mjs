import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const PORTABLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PORTABLE_DATASET_RE = /^[a-z0-9][a-z0-9_]*$/;

export function assertPortableName(name, label = "name") {
  if (typeof name !== "string" || !PORTABLE_NAME_RE.test(name)) {
    throw new Error(`${label} must be lowercase ASCII and may contain digits, hyphen, or underscore: ${name}`);
  }
  return name;
}

export function assertDatasetName(name) {
  if (typeof name !== "string" || !PORTABLE_DATASET_RE.test(name)) {
    throw new Error(`dataset must be lowercase ASCII and may contain digits or underscore: ${name}`);
  }
  return name;
}

export function normalizeProjectPath(input) {
  if (typeof input !== "string") {
    throw new Error("path must be a string");
  }
  const value = input.trim();
  if (!value) {
    throw new Error("path must not be empty");
  }
  if (value.includes("\\")) {
    throw new Error(`persisted paths must use '/' separators: ${input}`);
  }
  if (path.posix.isAbsolute(value) || WINDOWS_DRIVE_RE.test(value)) {
    throw new Error(`persisted paths must be project-relative: ${input}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`persisted paths must not contain empty, '.', or '..' segments: ${input}`);
  }
  return parts.join("/");
}

export function resolveProjectPath(rootDir, projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`resolved path escapes project root: ${projectPath}`);
  }
  return resolved;
}

export async function readJsonUtf8(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export async function writeJsonUtf8Atomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const handle = await fs.open(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o666);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
}
