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

const VALID = new Set(["accepted", "changes-requested", "blocked"]);

function usage() {
  console.log("用法：");
  console.log("  node tools/ai-coord/review-task.mjs --agent claude --task <task-id> --verdict <accepted|changes-requested|blocked> --artifact <path>");
}

const args = parseArgs(process.argv.slice(2));
const agent = String(args.agent && args.agent !== true ? args.agent : "claude");
const taskId = requireArg(args, "task");
const verdict = requireArg(args, "verdict");
const artifact = requireArg(args, "artifact");

if (!VALID.has(verdict)) {
  usage();
  throw new Error("--verdict 必须是 accepted、changes-requested 或 blocked");
}

await ensureCoordDirs();

const { filePath, task } = await getTaskById(taskId);

// 允许评审 awaiting-review 任务；也允许回填评审历史遗留的 done（无 review_status）任务。
const reviewable =
  task.status === "awaiting-review" || (task.status === "done" && !task.review_status);
if (!reviewable) {
  throw new Error(`任务 ${taskId} 当前状态为 ${task.status}，不在可评审状态（awaiting-review）。`);
}

task.reviewed_by = agent;
task.reviewed_at = nowIso();
task.review_status = verdict;
task.review_artifact = artifact;

if (verdict === "accepted") {
  task.status = "done";
} else if (verdict === "changes-requested") {
  task.status = "changes-requested";
} else {
  task.status = "blocked";
  task.blocked_reason = "实现评审阻塞，待人工负责人裁决";
}

await writeJson(filePath, task);
await appendLog({ event: "task_review_completed", agent, task_id: taskId, verdict, artifact });
console.log(`任务评审已记录：${taskId} -> ${verdict}`);
