import { promises as fs } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const COORD_DIR = path.join(ROOT, ".ai-coord");
export const TASKS_DIR = path.join(COORD_DIR, "tasks");
export const LOCKS_DIR = path.join(COORD_DIR, "locks");
export const INBOX_DIR = path.join(COORD_DIR, "inbox");
export const ARTIFACTS_DIR = path.join(COORD_DIR, "artifacts");
export const LOGS_DIR = path.join(COORD_DIR, "logs");
export const EVENTS_DIR = path.join(COORD_DIR, "events");

export function parseArgs(argv) {
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

export function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) {
    throw new Error(`缺少必要参数：--${key}`);
  }
  return String(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function ensureCoordDirs() {
  const dirs = [
    LOCKS_DIR,
    ARTIFACTS_DIR,
    EVENTS_DIR
  ];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmpPath, body, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function appendLog(event) {
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const filePath = path.join(EVENTS_DIR, `${day}.jsonl`);
  const body = `${JSON.stringify({ ts: nowIso(), ...event })}\n`;
  await fs.appendFile(filePath, body, "utf8");
}

export async function listJsonFiles(dir, suffix = ".json") {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => name.endsWith(suffix))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function listTasks() {
  const files = await listJsonFiles(TASKS_DIR, ".json");
  const tasks = [];
  for (const filePath of files) {
    try {
      tasks.push({ filePath, task: await readJson(filePath) });
    } catch (error) {
      tasks.push({ filePath, error });
    }
  }
  return tasks;
}

export async function getTaskById(taskId) {
  const tasks = await listTasks();
  const found = tasks.find(({ task }) => task?.task_id === taskId);
  if (!found) {
    throw new Error(`找不到任务：${taskId}`);
  }
  if (found.error) {
    throw found.error;
  }
  return found;
}

export function taskAssignee(task) {
  return task.assignee ?? task.assigned_to ?? task.assignedTo;
}

export function normalizeAgent(agent) {
  return String(agent).trim().toLowerCase();
}

export function lockFileFor(resource) {
  const safe = String(resource).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(LOCKS_DIR, `${safe}.lock.json`);
}

export function isLockExpired(lock, at = new Date()) {
  if (!lock?.expires_at) return false;
  return new Date(lock.expires_at).getTime() <= at.getTime();
}

export async function listLocks({ includeExpired = true } = {}) {
  const files = await listJsonFiles(LOCKS_DIR, ".lock.json");
  const locks = [];
  for (const filePath of files) {
    try {
      const lock = await readJson(filePath);
      if (includeExpired || !isLockExpired(lock)) {
        locks.push({ filePath, lock });
      }
    } catch (error) {
      locks.push({ filePath, error });
    }
  }
  return locks;
}

export async function findBlockingLocks(task, agent) {
  const required = new Set(toArray(task.requires));
  const locks = await listLocks({ includeExpired: false });
  const normalizedAgent = normalizeAgent(agent);
  return locks.filter(({ lock }) => {
    if (!lock?.resource) return false;
    const resource = String(lock.resource);
    const owner = normalizeAgent(lock.owner ?? "");
    if (owner === normalizedAgent) return false;
    return required.has(resource);
  });
}

export function renderPrompt(task, agent) {
  const requires = toArray(task.requires);
  const forbidden = toArray(task.forbidden);
  const outputs = toArray(task.outputs);
  const lines = [
    `# 任务 ${task.task_id}`,
    "",
    `分配给：${agent}`,
    `交接状态：claimed`,
    "",
    "## 任务说明",
    "",
    task.instructions ?? "（未提供任务说明。）",
    "",
    "## 需要资源",
    "",
    requires.length ? requires.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "## 禁止事项",
    "",
    forbidden.length ? forbidden.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "## 预期输出",
    "",
    outputs.length ? outputs.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "## 完成协议",
    "",
    "完成后，先写出要求的输出物，再用下面命令标记任务完成：",
    "",
    "```powershell",
    `node tools/ai-coord/finish-task.mjs --agent ${agent} --task ${task.task_id} --status done`,
    "```",
    ""
  ];
  if (task.stop_after_done) {
    lines.push("完成这个任务后停止，并向用户报告结果。", "");
  }
  return lines.join("\n");
}

export function formatLock(lock) {
  const expired = isLockExpired(lock) ? "，已过期" : "";
  return `${lock.resource}，持有者=${lock.owner}${expired}，有效期至=${lock.expires_at ?? "手动释放"}`;
}
