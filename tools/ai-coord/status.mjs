#!/usr/bin/env node
import path from "node:path";
import {
  ensureCoordDirs,
  formatLock,
  isLockExpired,
  listLocks,
  listTasks,
  loadBindings,
  parseArgs,
  resolveTaskAssignee,
  taskAssignee
} from "./lib/core.mjs";

// v2 任务卡可以只声明 capability_required、没有字面 assignee，实际负责人要靠 spec 的
// bindings.json 解析——不然这里会把它显示成"未分配"，但 next-task.mjs 其实已经能正确
// 认领它，仪表盘和真实调度状态就对不上了。按 spec 缓存 bindings，避免重复读文件。
const bindingsCache = new Map();
async function displayAssignee(task) {
  const explicit = taskAssignee(task);
  if (explicit) return explicit;
  if (!task.capability_required) return "未分配";
  if (!bindingsCache.has(task.spec)) {
    bindingsCache.set(task.spec, await loadBindings(task.spec));
  }
  const resolved = resolveTaskAssignee(task, bindingsCache.get(task.spec));
  return resolved ? `${resolved}（按能力 ${task.capability_required} 解析）` : "未分配";
}

const args = parseArgs(process.argv.slice(2));
// 可选 --spec 过滤：不传时行为与改造前逐字节一致（展示全部任务）；传入时只展示该 spec 的任务卡。
const spec = args.spec && args.spec !== true ? String(args.spec) : null;

await ensureCoordDirs();

const allTasks = await listTasks();
const tasks = spec ? allTasks.filter(({ task }) => task?.spec === spec) : allTasks;
const locks = await listLocks();

console.log("AI 协作状态");
console.log("======================");
console.log("");

console.log(`任务${spec ? `（spec=${spec}）` : ""}`);
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
    const assignee = await displayAssignee(task);
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
