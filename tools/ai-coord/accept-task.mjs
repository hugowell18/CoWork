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

const VALID = new Set(["accepted", "rejected"]);

function usage() {
  console.log("用法：");
  console.log(
    '  node tools/ai-coord/accept-task.mjs --agent <human-identity> --task <task-id> --decision <accepted|rejected> --artifact <path> [--notes "..."]'
  );
  console.log("");
  console.log(
    "专供人工最终验收使用：写入独立的 human_acceptance 字段，绝不覆盖 AI 评审记录（reviews[] / review_status / reviewed_by / review_artifact）。"
  );
}

const args = parseArgs(process.argv.slice(2));
const agent = requireArg(args, "agent");
const taskId = requireArg(args, "task");
const decision = requireArg(args, "decision");
const artifact = requireArg(args, "artifact");
const notes = args.notes && args.notes !== true ? String(args.notes) : null;

if (!VALID.has(decision)) {
  usage();
  throw new Error("--decision 必须是 accepted 或 rejected");
}

await ensureCoordDirs();

const { filePath, task } = await getTaskById(taskId);

// 只允许从 awaiting-human-acceptance 验收（这个状态只有在 AI 评审——单一 reviewer 或
// 对抗评审池——已经判定 accepted 之后才会出现）；也允许给尚未记录人工验收的历史 done
// 任务回填一次（对照 review-task.mjs 对遗留 done 任务回填评审历史的同类允许）。
//
// 特意不允许从 awaiting-review 直接验收：那意味着评审可能还没做完（对抗评审池只有部分
// seat 提交、聚合结果还是 pending 时，任务状态也是 awaiting-review），人工在这个状态点头
// 会绕过"全部 seat 提交后才聚合"的硬性规则。
const acceptable =
  task.status === "awaiting-human-acceptance" ||
  (task.status === "done" && !task.human_acceptance);
if (!acceptable) {
  throw new Error(
    `任务 ${taskId} 当前状态为 ${task.status}，不在可人工验收状态（awaiting-human-acceptance，或尚未记录人工验收的 done）。如果还在 awaiting-review，说明 AI 评审尚未完成或尚未全部通过，必须先完成评审。`
  );
}

// 防御性校验：awaiting-human-acceptance 正常只能通过 review-task.mjs 判定 accepted 后
// 才会出现；如果状态和评审记录对不上（例如任务卡被手工改过 status），拒绝验收而不是
// 静默放行。done 状态的历史回填不做这层校验，因为老任务卡可能压根没有 review_status
// （没有声明 reviewer 的任务本来就不需要评审）。
if (task.status === "awaiting-human-acceptance") {
  const reviewLooksAccepted =
    task.review_aggregation?.status === "accepted" || task.review_status === "accepted";
  if (!reviewLooksAccepted) {
    throw new Error(
      `任务 ${taskId} 状态是 awaiting-human-acceptance，但评审记录（reviews[]/review_aggregation 或 review_status）不是 accepted，拒绝验收。请检查任务卡是否被手工改动过。`
    );
  }
}

task.human_acceptance = {
  status: decision,
  by: agent,
  at: nowIso(),
  artifact,
  notes
};

if (decision === "accepted") {
  task.status = "done";
} else {
  task.status = "blocked";
  task.blocked_reason = "人工验收驳回，待人工负责人后续处理";
}

await writeJson(filePath, task);
await appendLog({
  event: "task_human_acceptance_recorded",
  agent,
  task_id: taskId,
  decision,
  artifact
});
console.log(
  `人工验收已记录：${taskId} -> ${decision}（reviews[]/review_status 等 AI 评审字段未被触碰）`
);
