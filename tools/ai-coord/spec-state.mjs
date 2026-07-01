#!/usr/bin/env node
import path from "node:path";
import {
  aggregateReviews,
  appendLog,
  assertSeatSubmission,
  ensureCoordDirs,
  getReviewPool,
  loadBindings,
  nowIso,
  parseArgs,
  readJson,
  requireArg,
  upsertSeatReview,
  writeJson
} from "./lib/core.mjs";

const ROOT = process.cwd();
const VALID_REVIEW_VERDICTS = new Set(["accepted", "changes-requested", "blocked"]);

function usage() {
  console.log("用法：");
  console.log("  node tools/ai-coord/spec-state.mjs show --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs requirements-ready --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs requirements-review --spec <spec-name> --verdict <accepted|changes-requested|blocked> --artifact <path>");
  console.log("  node tools/ai-coord/spec-state.mjs human-approve-requirements --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs design-ready --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs design-review --spec <spec-name> --verdict <accepted|changes-requested|blocked> --artifact <path>");
  console.log("  node tools/ai-coord/spec-state.mjs human-approve-design --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs tasks-ready --spec <spec-name>");
  console.log("  node tools/ai-coord/spec-state.mjs tasks-review --spec <spec-name> --verdict <accepted|changes-requested|blocked> --artifact <path>");
  console.log("  node tools/ai-coord/spec-state.mjs human-approve-tasks --spec <spec-name>");
  console.log("");
  console.log("  对抗评审池模式（需 spec 的 bindings.json 声明 review_pools.<requirements|design|tasks>）：");
  console.log("  上面三个 *-review 命令额外加 --seat <seat_id> --agent <agent>，每个 seat 独立提交，全部 seat 提交后才聚合出最终结论。");
}

function statePathFor(spec) {
  return path.join(ROOT, ".kiro", "specs", spec, "state.json");
}

async function loadState(spec) {
  return readJson(statePathFor(spec));
}

async function saveState(spec, state) {
  await writeJson(statePathFor(spec), state);
}

function ensureRequirements(state) {
  state.requirements ??= {};
  state.requirements.owner ??= "codex";
  state.requirements.reviewer ??= "claude";
  state.requirements.accepted_by_claude ??= false;
  state.requirements.approved_by_human ??= false;
  return state.requirements;
}
function ensureDesign(state) {
  state.design ??= {};
  state.design.owner ??= "codex";
  state.design.reviewer ??= "claude";
  state.design.accepted_by_claude ??= false;
  state.design.approved_by_human ??= false;
  return state.design;
}

function ensureTasks(state) {
  state.tasks ??= {};
  state.tasks.owner ??= "codex";
  state.tasks.reviewer ??= "claude";
  state.tasks.accepted_by_claude ??= false;
  state.tasks.approved_by_human ??= false;
  return state.tasks;
}

// 对抗评审池路径：只在调用方传了 --seat 时触发，需要 spec 的 bindings.json 声明
// review_pools.<stage>。没有 --seat 的既有调用方式完全不受影响，继续走各命令原有的
// 单一 verdict 逻辑（见下方各 command 分支里 "legacy path" 的注释）。
async function submitPoolReview({ spec, stage, ensureFn, seatId, agent, verdict, artifact }) {
  const state = await loadState(spec);
  const field = ensureFn(state);
  const bindings = await loadBindings(spec);
  // producerAgent 优先取 bindings.json 里 architect 能力绑定的具体 agent；只有 spec
  // 没有 bindings.json（或没声明 architect）时，才退回 field.owner —— field.owner 是
  // ensure* 函数里硬编码默认成 "codex" 的字段，如果直接用它做自证判断，一旦 spec 的
  // bindings.json 把 architect 换成别的 agent（角色对调），这里还是会拿旧默认值比对，
  // 挡不住真正的自证。
  const producerAgent = bindings?.capabilities?.architect ?? field.owner;
  const { pool } = assertSeatSubmission({ bindings, stage, seatId, agent, producerAgent });

  field.reviews = upsertSeatReview(field.reviews, {
    seat_id: seatId,
    agent,
    verdict,
    artifact,
    reviewed_at: nowIso()
  });
  const aggregation = aggregateReviews(field.reviews, pool.seats.length, pool.aggregation ?? "unanimous");
  field.review_aggregation = aggregation;
  field.last_review_artifact = artifact;
  field.reviewed_at = nowIso();
  field.review_status = aggregation.status;

  // 镜像回既有的 status/accepted_by_claude 字段，让 human-approve-* 命令不需要
  // 任何改动就能继续工作；聚合结果仍未定（pending）时保持 waiting-claude-review，
  // 不提前下结论。
  if (aggregation.status === "accepted") {
    field.status = "accepted-by-claude";
    field.accepted_by_claude = true;
  } else if (aggregation.status === "changes-requested") {
    field.status = "changes-requested";
    field.accepted_by_claude = false;
  } else if (aggregation.status === "blocked") {
    field.status = "blocked";
    field.accepted_by_claude = false;
  } else {
    field.status = "waiting-claude-review";
    field.accepted_by_claude = false;
  }

  await saveState(spec, state);
  await appendLog({
    event: `${stage}_pool_review_submitted`,
    spec,
    seat_id: seatId,
    agent,
    verdict,
    artifact,
    aggregate_status: aggregation.status
  });
  console.log(
    `${stage} 评审 seat 已记录：${spec} seat=${seatId} agent=${agent} -> ${verdict}（聚合状态：${aggregation.status}）`
  );
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command) {
  usage();
  process.exit(1);
}

await ensureCoordDirs();

if (command === "show") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

if (command === "requirements-ready") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  if (state.phase !== "requirements") {
    throw new Error("requirements phase is closed; cannot submit requirements review.");
  }
  const requirements = ensureRequirements(state);
  const revision = Number(requirements.revision ?? 0) + 1;
  requirements.status = "waiting-claude-review";
  requirements.review_status = "pending";
  requirements.accepted_by_claude = false;
  requirements.approved_by_human = false;
  requirements.revision = revision;
  requirements.updated_at = nowIso();
  await saveState(spec, state);
  await appendLog({
    event: "requirements_drafted",
    spec,
    owner: requirements.owner,
    reviewer: requirements.reviewer,
    revision
  });
  console.log(`requirements draft entered Claude review: ${spec} r${revision}`);
  process.exit(0);
}

if (command === "requirements-review") {
  const spec = requireArg(args, "spec");
  const verdict = requireArg(args, "verdict");
  const artifact = requireArg(args, "artifact");
  if (!VALID_REVIEW_VERDICTS.has(verdict)) {
    throw new Error("--verdict must be accepted, changes-requested, or blocked");
  }

  const seatId = args.seat && args.seat !== true ? String(args.seat) : null;
  const poolCheckBindings = await loadBindings(spec);
  const requirementsPool = getReviewPool(poolCheckBindings, "requirements");
  if (requirementsPool && !seatId) {
    throw new Error(
      `spec ${spec} 的 requirements 阶段已声明对抗评审池（review_pools.requirements），必须使用 --seat 提交，不能走单一评审路径。`
    );
  }
  if (seatId) {
    const agent = requireArg(args, "agent");
    await submitPoolReview({ spec, stage: "requirements", ensureFn: ensureRequirements, seatId, agent, verdict, artifact });
    process.exit(0);
  }

  // legacy path：没有 --seat 时和改造前逐字节一致。
  const state = await loadState(spec);
  const requirements = ensureRequirements(state);
  requirements.last_review_artifact = artifact;
  requirements.reviewed_at = nowIso();
  requirements.review_status = verdict;

  if (verdict === "accepted") {
    requirements.status = "accepted-by-claude";
    requirements.accepted_by_claude = true;
  } else if (verdict === "changes-requested") {
    requirements.status = "changes-requested";
    requirements.accepted_by_claude = false;
  } else {
    requirements.status = "blocked";
    requirements.accepted_by_claude = false;
  }

  await saveState(spec, state);
  await appendLog({
    event: "requirements_review_completed",
    spec,
    reviewer: requirements.reviewer,
    verdict,
    artifact
  });
  console.log(`requirements review recorded: ${spec} -> ${verdict}`);
  process.exit(0);
}

if (command === "human-approve-requirements") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  const requirements = ensureRequirements(state);
  if (requirements.status !== "accepted-by-claude" || requirements.accepted_by_claude !== true) {
    throw new Error("requirements have not been accepted by Claude; human approval cannot advance design.");
  }
  requirements.status = "approved";
  requirements.approved_by_human = true;
  requirements.approved_at = nowIso();
  state.phase = "design";
  state.design ??= {};
  state.design.status = "ready-to-draft";
  state.design.owner ??= "codex";
  state.design.reviewer ??= "claude";
  state.design.review_status = "not-started";
  state.design.accepted_by_claude = false;
  state.design.approved_by_human = false;
  await saveState(spec, state);
  await appendLog({ event: "requirements_approved_by_human", spec, next_phase: "design" });
  console.log(`requirements approved by human owner: ${spec}; next phase design.`);
  process.exit(0);
}
if (command === "design-ready") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  const requirements = ensureRequirements(state);
  if (state.phase !== "design" || requirements.status !== "approved" || requirements.approved_by_human !== true) {
    throw new Error("requirements are not finally approved; cannot submit design review.");
  }
  const design = ensureDesign(state);
  const revision = Number(design.revision ?? 0) + 1;
  state.phase = "design";
  design.status = "waiting-claude-review";
  design.review_status = "pending";
  design.accepted_by_claude = false;
  design.approved_by_human = false;
  design.revision = revision;
  design.updated_at = nowIso();
  await saveState(spec, state);
  await appendLog({
    event: "design_drafted",
    spec,
    owner: design.owner,
    reviewer: design.reviewer,
    revision
  });
  console.log(`设计草案已进入 Claude 评审：${spec} r${revision}`);
  process.exit(0);
}

if (command === "design-review") {
  const spec = requireArg(args, "spec");
  const verdict = requireArg(args, "verdict");
  const artifact = requireArg(args, "artifact");
  if (!VALID_REVIEW_VERDICTS.has(verdict)) {
    throw new Error("--verdict 必须是 accepted、changes-requested 或 blocked");
  }

  const seatId = args.seat && args.seat !== true ? String(args.seat) : null;
  const poolCheckBindings = await loadBindings(spec);
  const designPool = getReviewPool(poolCheckBindings, "design");
  if (designPool && !seatId) {
    throw new Error(
      `spec ${spec} 的 design 阶段已声明对抗评审池（review_pools.design），必须使用 --seat 提交，不能走单一评审路径。`
    );
  }
  if (seatId) {
    const agent = requireArg(args, "agent");
    await submitPoolReview({ spec, stage: "design", ensureFn: ensureDesign, seatId, agent, verdict, artifact });
    process.exit(0);
  }

  // legacy path：没有 --seat 时和改造前逐字节一致。
  const state = await loadState(spec);
  const design = ensureDesign(state);
  design.last_review_artifact = artifact;
  design.reviewed_at = nowIso();
  design.review_status = verdict;

  if (verdict === "accepted") {
    design.status = "accepted-by-claude";
    design.accepted_by_claude = true;
  } else if (verdict === "changes-requested") {
    design.status = "changes-requested";
    design.accepted_by_claude = false;
  } else {
    design.status = "blocked";
    design.accepted_by_claude = false;
  }

  await saveState(spec, state);
  await appendLog({
    event: "design_review_completed",
    spec,
    reviewer: design.reviewer,
    verdict,
    artifact
  });
  console.log(`设计评审已记录：${spec} -> ${verdict}`);
  process.exit(0);
}

if (command === "human-approve-design") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  const design = ensureDesign(state);
  if (design.status !== "accepted-by-claude" || design.accepted_by_claude !== true) {
    throw new Error("设计尚未被 Claude 接受，不能进入人工最终批准。");
  }
  design.status = "approved";
  design.approved_by_human = true;
  design.approved_at = nowIso();
  state.phase = "tasks";
  state.tasks ??= {};
  state.tasks.status = "ready-to-draft";
  state.tasks.owner ??= "codex";
  state.tasks.reviewer ??= "claude";
  state.tasks.review_status = "not-started";
  state.tasks.accepted_by_claude = false;
  state.tasks.approved_by_human = false;
  await saveState(spec, state);
  await appendLog({ event: "design_approved_by_human", spec, next_phase: "tasks" });
  console.log(`设计已由人工负责人最终批准：${spec}，下一阶段 tasks。`);
  process.exit(0);
}

if (command === "tasks-ready") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  const design = ensureDesign(state);
  if (state.phase !== "tasks" || design.status !== "approved" || design.approved_by_human !== true) {
    throw new Error("设计尚未最终批准，不能提交任务拆解评审。");
  }
  const tasks = ensureTasks(state);
  const revision = Number(tasks.revision ?? 0) + 1;
  tasks.status = "waiting-claude-review";
  tasks.review_status = "pending";
  tasks.accepted_by_claude = false;
  tasks.approved_by_human = false;
  tasks.revision = revision;
  tasks.updated_at = nowIso();
  await saveState(spec, state);
  await appendLog({
    event: "tasks_drafted",
    spec,
    owner: tasks.owner,
    reviewer: tasks.reviewer,
    revision
  });
  console.log(`任务拆解草案已进入 Claude 评审：${spec} r${revision}`);
  process.exit(0);
}

if (command === "tasks-review") {
  const spec = requireArg(args, "spec");
  const verdict = requireArg(args, "verdict");
  const artifact = requireArg(args, "artifact");
  if (!VALID_REVIEW_VERDICTS.has(verdict)) {
    throw new Error("--verdict 必须是 accepted、changes-requested 或 blocked");
  }

  const seatId = args.seat && args.seat !== true ? String(args.seat) : null;
  const poolCheckBindings = await loadBindings(spec);
  const tasksPool = getReviewPool(poolCheckBindings, "tasks");
  if (tasksPool && !seatId) {
    throw new Error(
      `spec ${spec} 的 tasks 阶段已声明对抗评审池（review_pools.tasks），必须使用 --seat 提交，不能走单一评审路径。`
    );
  }
  if (seatId) {
    const agent = requireArg(args, "agent");
    await submitPoolReview({ spec, stage: "tasks", ensureFn: ensureTasks, seatId, agent, verdict, artifact });
    process.exit(0);
  }

  // legacy path：没有 --seat 时和改造前逐字节一致。
  const state = await loadState(spec);
  const tasks = ensureTasks(state);
  tasks.last_review_artifact = artifact;
  tasks.reviewed_at = nowIso();
  tasks.review_status = verdict;

  if (verdict === "accepted") {
    tasks.status = "accepted-by-claude";
    tasks.accepted_by_claude = true;
  } else if (verdict === "changes-requested") {
    tasks.status = "changes-requested";
    tasks.accepted_by_claude = false;
  } else {
    tasks.status = "blocked";
    tasks.accepted_by_claude = false;
  }

  await saveState(spec, state);
  await appendLog({
    event: "tasks_review_completed",
    spec,
    reviewer: tasks.reviewer,
    verdict,
    artifact
  });
  console.log(`任务拆解评审已记录：${spec} -> ${verdict}`);
  process.exit(0);
}

if (command === "human-approve-tasks") {
  const spec = requireArg(args, "spec");
  const state = await loadState(spec);
  const tasks = ensureTasks(state);
  if (tasks.status !== "accepted-by-claude" || tasks.accepted_by_claude !== true) {
    throw new Error("任务拆解尚未被 Claude 接受，不能进入人工最终批准。");
  }
  tasks.status = "approved";
  tasks.approved_by_human = true;
  tasks.approved_at = nowIso();
  state.phase = "execution";
  state.execution ??= {};
  state.execution.status = "ready-to-create-queue";
  await saveState(spec, state);
  await appendLog({ event: "tasks_approved_by_human", spec, next_phase: "execution" });
  console.log(`任务拆解已由人工负责人最终批准：${spec}，下一阶段 execution。`);
  process.exit(0);
}

usage();
process.exit(1);
