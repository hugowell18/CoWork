#!/usr/bin/env node
import path from "node:path";
import {
  appendLog,
  ensureCoordDirs,
  nowIso,
  parseArgs,
  readJson,
  requireArg,
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
