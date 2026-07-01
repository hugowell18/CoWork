#!/usr/bin/env node
import {
  aggregateReviews,
  appendLog,
  assertSeatSubmission,
  ensureCoordDirs,
  getReviewPool,
  getTaskById,
  loadBindings,
  nowIso,
  parseArgs,
  requireArg,
  resolveTaskAssignee,
  upsertSeatReview,
  writeJson
} from "./lib/core.mjs";

const VALID = new Set(["accepted", "changes-requested", "blocked"]);

function usage() {
  console.log("用法：");
  console.log(
    "  node tools/ai-coord/review-task.mjs --agent claude --task <task-id> --verdict <accepted|changes-requested|blocked> --artifact <path>"
  );
  console.log(
    "  对抗评审池模式（需 spec 的 bindings.json 声明 review_pools.execution）：额外加 --seat <seat_id>"
  );
}

const args = parseArgs(process.argv.slice(2));
const agent = String(args.agent && args.agent !== true ? args.agent : "claude");
const taskId = requireArg(args, "task");
const verdict = requireArg(args, "verdict");
const artifact = requireArg(args, "artifact");
const seatId = args.seat && args.seat !== true ? String(args.seat) : null;

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

// requires_human_acceptance 是新任务契约的可选字段：旧任务卡没有这个字段（undefined），
// 下面的判断恒为 false，行为和改造前完全一致。
const requiresHumanAcceptance = task.process_contract?.requires_human_acceptance === true;

function statusAfterAcceptance() {
  return requiresHumanAcceptance ? "awaiting-human-acceptance" : "done";
}

const bindings = await loadBindings(task.spec);
const pool = getReviewPool(bindings, "execution");

if (pool && !seatId) {
  // spec 一旦为 execution 阶段声明了对抗评审池，就不允许再用不带 --seat 的单一评审
  // 路径悄悄通过——否则声明了池子也形同虚设，一个人就能绕过"全部 seat 提交后才聚合"
  // 这条硬性规则。
  throw new Error(
    `spec ${task.spec} 的 execution 阶段已声明对抗评审池（review_pools.execution），必须使用 --seat 提交，不能走单一评审路径。`
  );
}

if (!seatId) {
  // legacy 单一评审路径：和改造前逐字节一致，只多了 requires_human_acceptance 这一个
  // 新增字段判断（旧任务卡没有这个字段，恒定走 "done" 分支）。
  task.reviewed_by = agent;
  task.reviewed_at = nowIso();
  task.review_status = verdict;
  task.review_artifact = artifact;

  if (verdict === "accepted") {
    task.status = statusAfterAcceptance();
  } else if (verdict === "changes-requested") {
    task.status = "changes-requested";
  } else {
    task.status = "blocked";
    task.blocked_reason = "实现评审阻塞，待人工负责人裁决";
  }

  await writeJson(filePath, task);
  await appendLog({ event: "task_review_completed", agent, task_id: taskId, verdict, artifact });
  console.log(`任务评审已记录：${taskId} -> ${verdict}`);
} else {
  // 对抗评审池路径：需要 spec 的 bindings.json 声明 review_pools.execution，且至少 2 个独立 seat。
  // producerAgent 优先用字面 assignee/assigned_to/assignedTo，任务卡只声明
  // capability_required（没有字面 assignee）时通过 bindings.json 解析，确保按能力
  // 标签指派的任务也能被正确识别产出者、挡住自证。
  const producerAgent = resolveTaskAssignee(task, bindings);
  // pool 已经在上面用 getReviewPool 取过；这里只需要 assertSeatSubmission 的校验副作用
  // （seat 存在、agent 匹配、非自证），不需要再拿一次返回值。
  assertSeatSubmission({ bindings, stage: "execution", seatId, agent, producerAgent });

  task.reviews = upsertSeatReview(task.reviews, {
    seat_id: seatId,
    agent,
    verdict,
    artifact,
    reviewed_at: nowIso()
  });
  const aggregation = aggregateReviews(task.reviews, pool.seats.length, pool.aggregation ?? "unanimous");
  task.review_aggregation = aggregation;

  if (aggregation.status === "pending") {
    // 还有 seat 没提交，任务保持 awaiting-review，不下最终结论。
    task.status = "awaiting-review";
  } else if (aggregation.status === "accepted") {
    task.status = statusAfterAcceptance();
  } else if (aggregation.status === "changes-requested") {
    task.status = "changes-requested";
  } else {
    task.status = "blocked";
    task.blocked_reason = "对抗评审池阻塞，待人工负责人裁决";
  }

  await writeJson(filePath, task);
  await appendLog({
    event: "task_pool_review_submitted",
    agent,
    task_id: taskId,
    seat_id: seatId,
    verdict,
    artifact,
    aggregate_status: aggregation.status
  });
  console.log(
    `评审 seat 已记录：${taskId} seat=${seatId} agent=${agent} -> ${verdict}（聚合状态：${aggregation.status}）`
  );
}
