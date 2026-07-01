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

// 下面这组 taskXxx() 读取函数是任务卡字段的统一入口：v2 任务卡（contract_version: 2）
// 把 requires/forbidden/outputs 分别拆到 resource_contract/process_contract/io_contract
// 里；legacy 任务卡（29 张既有任务卡）仍然是扁平字段。任何要读这些字段的地方（锁检查、
// 渲染 prompt、领取时写回的元数据）都必须走这几个函数，不能再直接读 task.requires 之类
// 的扁平字段——否则 v2 任务卡声明的资源需求会被锁检查和 prompt 渲染悄悄无视。
export function taskRequiredResources(task) {
  return toArray(task.resource_contract?.requires ?? task.requires);
}

export function taskForbiddenResources(task) {
  return toArray(task.resource_contract?.forbidden ?? task.forbidden);
}

export function taskForbiddenBehaviors(task) {
  return toArray(task.process_contract?.forbidden_behaviors);
}

export function taskOutputs(task) {
  return toArray(task.io_contract?.outputs ?? task.outputs);
}

export function taskAllowedWrites(task) {
  return toArray(task.io_contract?.allowed_writes);
}

export function taskRequiredInputs(task) {
  return toArray(task.io_contract?.required_inputs);
}

export async function findBlockingLocks(task, agent) {
  const required = new Set(taskRequiredResources(task));
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
  const requires = taskRequiredResources(task);
  // 禁止事项对 v2 任务卡来说分两种：resource_contract.forbidden（禁止使用的资源）和
  // process_contract.forbidden_behaviors（禁止的行为），渲染时合并展示，因为 prompt
  // 读者（implementer）需要同时知道这两类边界。
  const forbidden = [...taskForbiddenResources(task), ...taskForbiddenBehaviors(task)];
  const outputs = taskOutputs(task);
  const requiredInputs = taskRequiredInputs(task);
  const allowedWrites = taskAllowedWrites(task);
  const acceptanceCriteria = toArray(task.acceptance_criteria);
  const knowledgeRefs = toArray(task.knowledge_refs);

  const lines = [
    `# 任务 ${task.task_id}`,
    "",
    `分配给：${agent}`,
    `交接状态：claimed`,
    "",
    "## 任务说明",
    "",
    task.instructions ?? (acceptanceCriteria.length ? "（无 prose 说明，以下面的验收标准为准。）" : "（未提供任务说明。）"),
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
    outputs.length ? outputs.map((item) => `- ${item}`).join("\n") : "- 无"
  ];

  if (requiredInputs.length) {
    lines.push("", "## 需要的输入", "", requiredInputs.map((item) => `- ${item}`).join("\n"));
  }
  if (allowedWrites.length) {
    lines.push("", "## 允许写入的路径", "", allowedWrites.map((item) => `- ${item}`).join("\n"));
  }
  if (acceptanceCriteria.length) {
    lines.push(
      "",
      "## 验收标准",
      "",
      acceptanceCriteria
        .map((item) => `- ${item.description ?? item.id ?? JSON.stringify(item)}${item.check_type ? `（${item.check_type}${item.check_ref ? `: ${item.check_ref}` : ""}）` : ""}`)
        .join("\n")
    );
  }
  if (knowledgeRefs.length) {
    lines.push(
      "",
      "## 需要先查阅的知识库文档",
      "",
      knowledgeRefs.map((item) => `- ${item.doc_id ?? JSON.stringify(item)}`).join("\n")
    );
  }

  lines.push(
    "",
    "## 完成协议",
    "",
    "完成后，先写出要求的输出物，再用下面命令标记任务完成：",
    "",
    "```powershell",
    `node tools/ai-coord/finish-task.mjs --agent ${agent} --task ${task.task_id} --status done`,
    "```",
    ""
  );
  if (task.stop_after_done) {
    lines.push("完成这个任务后停止，并向用户报告结果。", "");
  }
  return lines.join("\n");
}

export function formatLock(lock) {
  const expired = isLockExpired(lock) ? "，已过期" : "";
  return `${lock.resource}，持有者=${lock.owner}${expired}，有效期至=${lock.expires_at ?? "手动释放"}`;
}

// ---- 能力绑定 + 对抗评审池（cowork-framework-generalization 新增，纯增量） ----
//
// 下面这组函数只在 spec 声明了 .kiro/specs/<spec>/bindings.json 时才会被调用；
// 没有 bindings.json 的既有 spec 完全不受影响，继续走各自现有的单一 reviewer 逻辑。

// 解析一个任务卡"实际归属谁"：优先用字面 assignee/assigned_to/assignedTo（legacy
// 和已显式指派的 v2 任务卡都适用）；只有 capability_required 且没有字面 assignee 时，
// 才通过 spec 的 bindings.json 把能力标签解析成具体 agent。这是让"按能力标签声明、
// 不写死 agent 名字"的 v2 任务卡真的能被 next-task.mjs 领取、也能在评审时正确识别出
// 谁是产出者（避免自证）的关键一步——只有 schema 没有这一步，capability_required
// 只是摆设。
export function resolveTaskAssignee(task, bindings) {
  const explicit = taskAssignee(task);
  if (explicit) return explicit;
  if (task?.capability_required && bindings) {
    return bindings.capabilities?.[task.capability_required] ?? null;
  }
  return null;
}

export async function loadBindings(spec) {
  const bindingsPath = path.join(ROOT, ".kiro", "specs", spec, "bindings.json");
  try {
    return await readJson(bindingsPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function getReviewPool(bindings, stage) {
  if (!bindings) return null;
  return bindings.review_pools?.[stage] ?? null;
}

const REVIEW_VERDICT_RANK = { accepted: 0, "changes-requested": 1, blocked: 2 };

// 聚合策略目前只支持 unanimous：任一 seat 给 blocked/changes-requested 就整体不通过；
// 只有全部声明的 seat 都提交且都是 accepted，才整体 accepted。seat 数不足时保持 pending，
// 不提前下结论。
export function aggregateReviews(reviews, expectedSeatCount, policy = "unanimous") {
  if (policy !== "unanimous") {
    throw new Error(`不支持的评审聚合策略：${policy}`);
  }
  const list = Array.isArray(reviews) ? reviews : [];
  if (list.length < expectedSeatCount) {
    return { policy, status: "pending" };
  }
  let worst = "accepted";
  for (const review of list) {
    if ((REVIEW_VERDICT_RANK[review.verdict] ?? -1) > REVIEW_VERDICT_RANK[worst]) {
      worst = review.verdict;
    }
  }
  return { policy, status: worst };
}

// 校验一次 seat 提交是否合法：池子至少 2 个独立 seat、seat 必须在池子里声明过、
// seat 绑定的 agent 必须和实际提交的 --agent 一致、且不允许产出者自证。
// 这里只能做"数据层面"的校验；"seat 之间必须是独立 CLI 窗口、提交前不得读取彼此
// verdict"这条独立性规则无法在单次 CLI 调用里机械验证，写在 .kiro/roles/reviewer.md
// 里作为协议约束，由人工负责人和各 seat 的操作者自觉遵守。
export function assertSeatSubmission({ bindings, stage, seatId, agent, producerAgent }) {
  const pool = getReviewPool(bindings, stage);
  if (!pool) {
    throw new Error(`spec 的 bindings.json 没有为阶段 ${stage} 声明 review_pools，不能使用 --seat 提交评审。`);
  }
  if (!Array.isArray(pool.seats) || pool.seats.length < 2) {
    throw new Error(`阶段 ${stage} 的评审池必须至少声明 2 个 seat，当前配置不满足对抗评审要求。`);
  }
  const seat = pool.seats.find((item) => item.seat_id === seatId);
  if (!seat) {
    throw new Error(`阶段 ${stage} 的评审池里找不到 seat：${seatId}`);
  }
  if (normalizeAgent(seat.agent) !== normalizeAgent(agent)) {
    throw new Error(`seat ${seatId} 绑定的 agent 是 ${seat.agent}，与传入的 --agent ${agent} 不一致。`);
  }
  if (producerAgent && normalizeAgent(producerAgent) === normalizeAgent(agent)) {
    throw new Error(`agent ${agent} 是该产物的产出者，不能同时担任评审 seat（禁止自证）。`);
  }
  return { pool, seat };
}

// 把一次 seat 提交合并进已有 reviews[]：同一个 seat_id 重新提交时覆盖旧记录，
// 而不是追加重复项，避免同一 seat 通过反复提交刷票。
export function upsertSeatReview(reviews, record) {
  const list = Array.isArray(reviews) ? reviews.slice() : [];
  const index = list.findIndex((item) => item.seat_id === record.seat_id);
  if (index === -1) {
    list.push(record);
  } else {
    list[index] = record;
  }
  return list;
}
