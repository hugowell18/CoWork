#!/usr/bin/env node
import {
  appendLog,
  ensureCoordDirs,
  getTaskById,
  nowIso,
  parseArgs,
  requireArg,
  writeJson
} from "./lib/core.mjs";

const args = parseArgs(process.argv.slice(2));
const agent = requireArg(args, "agent");
const taskId = requireArg(args, "task");
const status = String(args.status ?? "done");

if (!["done", "failed", "cancelled"].includes(status)) {
  throw new Error("--status 必须是以下之一：done, failed, cancelled");
}

await ensureCoordDirs();

const { filePath, task } = await getTaskById(taskId);
task.finished_by = agent;
task.finished_at = nowIso();
if (args.result && args.result !== true) {
  task.result = String(args.result);
}
if (args.summary && args.summary !== true) {
  task.summary = String(args.summary);
}

// 逐任务评审门禁：实现完成后，如果任务声明了 reviewer（legacy 单一评审）或者是
// contract_version 2 的任务卡（总是要求 acceptance_criteria / 评审池），不直接置为
// done，而是进入 awaiting-review，等待评审通过后才算真正完成。
if (status === "done" && (task.reviewer || task.contract_version === 2)) {
  task.implementation_status = "done";
  task.implementation_done_at = nowIso();
  task.status = "awaiting-review";
  task.review_status = "pending";
  delete task.reviewed_at;
  delete task.reviewed_by;
  delete task.review_artifact;
  // 重新提交评审时清空上一轮的评审池记录，避免旧 verdict 被当成对新产出的评审。
  delete task.reviews;
  delete task.review_aggregation;
  await writeJson(filePath, task);
  await appendLog({ event: "task_awaiting_review", agent, task_id: taskId, reviewer: task.reviewer ?? "review-pool" });
  console.log(`任务 ${taskId} 实现已完成，进入 ${task.reviewer ?? "评审池"} 评审（awaiting-review）。`);
  console.log("评审通过前不要领取新任务；若收到 changes-requested，请按评审 artifact 返工后重新运行本命令。");
} else {
  task.status = status;
  await writeJson(filePath, task);
  await appendLog({ event: "task_finished", agent, task_id: taskId, status, result: task.result });
  console.log(`任务 ${taskId} 已标记为 ${status}。`);
}
