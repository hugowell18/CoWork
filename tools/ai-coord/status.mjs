#!/usr/bin/env node
import path from "node:path";
import {
  ensureCoordDirs,
  formatLock,
  isLockExpired,
  listLocks,
  listTasks,
  taskAssignee
} from "./lib/core.mjs";

await ensureCoordDirs();

const tasks = await listTasks();
const locks = await listLocks();

console.log("AI 协作状态");
console.log("======================");
console.log("");

console.log("任务");
console.log("-----");
if (!tasks.length) {
  console.log("没有任务卡。");
} else {
  for (const item of tasks) {
    if (item.error) {
      console.log(`- ${path.basename(item.filePath)}：JSON 无效（${item.error.message}）`);
      continue;
    }
    const task = item.task;
    const id = task.task_id ?? path.basename(item.filePath);
    const status = task.status ?? "未知";
    const assignee = taskAssignee(task) ?? "未分配";
    const suffix = task.blocked_reason ? ` (${task.blocked_reason})` : "";
    console.log(`- ${id}：状态=${status}，负责人=${assignee}${suffix}`);
  }
}

console.log("");
console.log("资源锁");
console.log("-----");
if (!locks.length) {
  console.log("没有资源锁。");
} else {
  for (const item of locks) {
    if (item.error) {
      console.log(`- ${path.basename(item.filePath)}：JSON 无效（${item.error.message}）`);
      continue;
    }
    const marker = isLockExpired(item.lock) ? " [已过期]" : "";
    console.log(`- ${formatLock(item.lock)}${marker}`);
  }
}
