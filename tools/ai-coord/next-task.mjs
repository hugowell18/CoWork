#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appendLog,
  ensureCoordDirs,
  findBlockingLocks,
  INBOX_DIR,
  listTasks,
  normalizeAgent,
  nowIso,
  parseArgs,
  renderPrompt,
  requireArg,
  taskAssignee,
  toArray,
  writeJson
} from "./lib/core.mjs";

const args = parseArgs(process.argv.slice(2));
const agent = normalizeAgent(requireArg(args, "agent"));

await ensureCoordDirs();

const allItems = (await listTasks()).filter(({ task, error }) => !error && task);

// 逐任务评审门禁：只要存在等待评审（awaiting-review）的任务，就不分配任何新任务（串行评审）。
const awaiting = allItems.filter(({ task }) => task.status === "awaiting-review");
if (awaiting.length) {
  const ids = awaiting.map(({ task }) => task.task_id).join(", ");
  console.log(`有任务在等待评审（awaiting-review）：${ids}。评审通过前不分配新任务。`);
  process.exit(0);
}

// 返工优先：分配给本 agent 的 changes-requested 任务必须先返工，再继续后续任务。
const reworks = allItems
  .filter(({ task }) => task.status === "changes-requested")
  .filter(({ task }) => normalizeAgent(taskAssignee(task) ?? "") === agent);
if (reworks.length) {
  const item = reworks[0];
  const task = item.task;
  task.status = "claimed";
  task.claimed_by = agent;
  task.claimed_at = nowIso();
  task.inbox_path = path.join(".ai-coord", "inbox", agent, `${task.task_id}.md`);
  await writeJson(item.filePath, task);

  const reviewRef = task.review_artifact
    ? `\n## 评审反馈\n\n请先阅读评审 artifact 并按其修改：\n- ${task.review_artifact}\n`
    : "";
  const prompt =
    `${renderPrompt(task, agent)}${reviewRef}\n本任务被要求修改（changes-requested）。返工完成后重新运行 finish-task 重新提交评审。\n`;
  const inboxPath = path.join(INBOX_DIR, agent, `${task.task_id}.md`);
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  await fs.writeFile(inboxPath, prompt, "utf8");
  await appendLog({ event: "task_rework_claimed", agent, task_id: task.task_id });

  console.log(prompt);
  console.log(`\nPrompt 已写入：${inboxPath}`);
  process.exit(0);
}

// 否则领取下一个 pending（或可重试的 blocked）任务。
const candidates = allItems
  .filter(({ task }) => task.status === "pending" || (task.status === "blocked" && Array.isArray(task.blocked_by)))
  .filter(({ task }) => normalizeAgent(taskAssignee(task) ?? "") === agent);

if (!candidates.length) {
  console.log(`没有分配给 ${agent} 的待处理任务。`);
  process.exit(0);
}

for (const item of candidates) {
  const task = item.task;
  const blockers = await findBlockingLocks(task, agent);
  if (blockers.length) {
    const blockedAt = nowIso();
    const resources = blockers.map(({ lock }) => lock.resource);
    task.status = "blocked";
    task.blocked_at = blockedAt;
    task.blocked_by = blockers.map(({ lock }) => ({
      resource: lock.resource,
      owner: lock.owner,
      expires_at: lock.expires_at
    }));
    task.blocked_reason = `资源被锁定：${resources.join(", ")}`;
    await writeJson(item.filePath, task);
    await appendLog({
      event: "task_blocked",
      agent,
      task_id: task.task_id,
      resources
    });
    console.log(`任务 ${task.task_id} 已阻塞：${task.blocked_reason}`);
    continue;
  }

  const claimedAt = nowIso();
  task.status = "claimed";
  task.claimed_by = agent;
  task.claimed_at = claimedAt;
  task.inbox_path = path.join(".ai-coord", "inbox", agent, `${task.task_id}.md`);
  task.required_resources = toArray(task.requires);
  delete task.blocked_at;
  delete task.blocked_by;
  delete task.blocked_reason;
  await writeJson(item.filePath, task);

  const prompt = renderPrompt(task, agent);
  const inboxPath = path.join(INBOX_DIR, agent, `${task.task_id}.md`);
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  await fs.writeFile(inboxPath, prompt, "utf8");
  await appendLog({
    event: "task_claimed",
    agent,
    task_id: task.task_id,
    inbox_path: task.inbox_path
  });

  console.log(prompt);
  console.log(`\nPrompt 已写入：${inboxPath}`);
  process.exit(0);
}

console.log(`没有可执行的待处理任务：${agent}`);
