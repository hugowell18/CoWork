#!/usr/bin/env node
// 轻量断言脚本：只用 Node 内置能力，不引入测试框架依赖。
// 只测纯函数和"显式传路径"的读写函数；不调用任何依赖真实 .ai-coord 状态
// （COORD_DIR/TASKS_DIR/LOCKS_DIR/EVENTS_DIR）的函数，避免污染或依赖真实协作数据。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateReviews,
  assertSeatSubmission,
  getReviewPool,
  isLockExpired,
  loadBindings,
  lockFileFor,
  normalizeAgent,
  parseArgs,
  readJson,
  renderPrompt,
  requireArg,
  resolveTaskAssignee,
  taskAssignee,
  taskForbiddenBehaviors,
  taskForbiddenResources,
  taskOutputs,
  taskRequiredResources,
  toArray,
  upsertSeatReview,
  writeJson
} from "./lib/core.mjs";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("parseArgs：解析 --flag value、裸 --flag 和位置参数", () => {
  const args = parseArgs(["--agent", "claude", "--flag-only", "--task", "T-1", "positional"]);
  assert.equal(args.agent, "claude");
  assert.equal(args["flag-only"], true);
  assert.equal(args.task, "T-1");
  assert.deepEqual(args._, ["positional"]);
});

test("requireArg：缺失或裸 flag 时抛错", () => {
  const args = parseArgs(["--flag"]);
  assert.throws(() => requireArg(args, "flag"));
  assert.throws(() => requireArg(args, "missing"));
});

test("normalizeAgent：去空格并转小写", () => {
  assert.equal(normalizeAgent(" Claude "), "claude");
});

test("toArray：标量/数组/空值统一成数组", () => {
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray("x"), ["x"]);
  assert.deepEqual(toArray(["a", "b"]), ["a", "b"]);
});

test("taskAssignee：兼容 assignee/assigned_to/assignedTo 三种历史字段名", () => {
  assert.equal(taskAssignee({ assignee: "codex" }), "codex");
  assert.equal(taskAssignee({ assigned_to: "claude" }), "claude");
  assert.equal(taskAssignee({ assignedTo: "codex" }), "codex");
});

test("lockFileFor：资源名里的非法字符被替换成下划线", () => {
  const filePath = lockFileFor("data-clean/daily_basic/period=2026");
  assert.equal(path.basename(filePath), "data-clean_daily_basic_period_2026.lock.json");
});

test("isLockExpired：按 expires_at 判断，缺失字段视为未过期", () => {
  assert.equal(isLockExpired({ expires_at: "2020-01-01T00:00:00.000Z" }), true);
  assert.equal(isLockExpired({ expires_at: "2999-01-01T00:00:00.000Z" }), false);
  assert.equal(isLockExpired({}), false);
});

test("writeJson/readJson：隔离临时目录里原子写入并读回一致（不触碰真实 .ai-coord）", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-self-test-"));
  try {
    const filePath = path.join(tmpRoot, "nested", "sample.json");
    await writeJson(filePath, { hello: "world", n: 1 });
    const readBack = await readJson(filePath);
    assert.deepEqual(readBack, { hello: "world", n: 1 });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("loadBindings：不存在的 spec 返回 null（不抛错）", async () => {
  const bindings = await loadBindings("spec-that-does-not-exist-in-this-repo");
  assert.equal(bindings, null);
});

test("getReviewPool：没有 bindings 或没有该阶段池子时返回 null", () => {
  assert.equal(getReviewPool(null, "design"), null);
  assert.equal(getReviewPool({ review_pools: {} }, "design"), null);
  const pool = { seats: [{ seat_id: "a", agent: "claude" }], aggregation: "unanimous" };
  assert.deepEqual(getReviewPool({ review_pools: { design: pool } }, "design"), pool);
});

test("aggregateReviews：seat 数不足时保持 pending，不提前下结论", () => {
  const result = aggregateReviews([{ verdict: "accepted" }], 2, "unanimous");
  assert.equal(result.status, "pending");
});

test("aggregateReviews：unanimous 策略下任一 blocked/changes-requested 就整体不通过", () => {
  const allAccepted = aggregateReviews(
    [{ verdict: "accepted" }, { verdict: "accepted" }],
    2,
    "unanimous"
  );
  assert.equal(allAccepted.status, "accepted");

  const oneChangesRequested = aggregateReviews(
    [{ verdict: "accepted" }, { verdict: "changes-requested" }],
    2,
    "unanimous"
  );
  assert.equal(oneChangesRequested.status, "changes-requested");

  const oneBlocked = aggregateReviews(
    [{ verdict: "blocked" }, { verdict: "accepted" }],
    2,
    "unanimous"
  );
  assert.equal(oneBlocked.status, "blocked");
});

test("aggregateReviews：不支持的策略直接抛错，不悄悄降级", () => {
  assert.throws(() => aggregateReviews([], 2, "majority"));
});

test("assertSeatSubmission：拒绝少于 2 个 seat 的池子（对抗评审硬性要求）", () => {
  const bindings = {
    review_pools: { design: { seats: [{ seat_id: "solo", agent: "claude" }], aggregation: "unanimous" } }
  };
  assert.throws(() =>
    assertSeatSubmission({ bindings, stage: "design", seatId: "solo", agent: "claude" })
  );
});

test("assertSeatSubmission：拒绝产出者自证评审", () => {
  const bindings = {
    review_pools: {
      design: {
        seats: [
          { seat_id: "reviewer-a", agent: "claude" },
          { seat_id: "reviewer-b", agent: "codex" }
        ],
        aggregation: "unanimous"
      }
    }
  };
  assert.throws(() =>
    assertSeatSubmission({
      bindings,
      stage: "design",
      seatId: "reviewer-b",
      agent: "codex",
      producerAgent: "codex"
    })
  );
});

test("assertSeatSubmission：seat 绑定的 agent 和实际提交的 --agent 不一致时拒绝", () => {
  const bindings = {
    review_pools: {
      design: {
        seats: [
          { seat_id: "reviewer-a", agent: "claude" },
          { seat_id: "reviewer-b", agent: "codex" }
        ],
        aggregation: "unanimous"
      }
    }
  };
  assert.throws(() =>
    assertSeatSubmission({ bindings, stage: "design", seatId: "reviewer-a", agent: "codex" })
  );
});

test("assertSeatSubmission：合法提交返回对应的 pool 和 seat", () => {
  const bindings = {
    review_pools: {
      design: {
        seats: [
          { seat_id: "reviewer-a", agent: "claude" },
          { seat_id: "reviewer-b", agent: "codex" }
        ],
        aggregation: "unanimous"
      }
    }
  };
  const { seat } = assertSeatSubmission({
    bindings,
    stage: "design",
    seatId: "reviewer-a",
    agent: "claude",
    producerAgent: "codex"
  });
  assert.equal(seat.seat_id, "reviewer-a");
});

test("upsertSeatReview：新 seat 追加，已提交过的 seat 覆盖而不是重复累加", () => {
  const first = upsertSeatReview([], { seat_id: "reviewer-a", verdict: "accepted" });
  assert.equal(first.length, 1);
  const withSecond = upsertSeatReview(first, { seat_id: "reviewer-b", verdict: "accepted" });
  assert.equal(withSecond.length, 2);
  const resubmitted = upsertSeatReview(withSecond, {
    seat_id: "reviewer-a",
    verdict: "changes-requested"
  });
  assert.equal(resubmitted.length, 2);
  assert.equal(resubmitted.find((item) => item.seat_id === "reviewer-a").verdict, "changes-requested");
});

test("resolveTaskAssignee：有字面 assignee 时优先用它，忽略 capability_required", () => {
  const bindings = { capabilities: { implementer: "claude" } };
  const task = { assignee: "codex", capability_required: "implementer" };
  assert.equal(resolveTaskAssignee(task, bindings), "codex");
});

test("resolveTaskAssignee：没有字面 assignee 时通过 capability_required + bindings 解析（v2 任务卡按能力认领的关键路径）", () => {
  const bindings = { capabilities: { implementer: "claude" } };
  const task = { capability_required: "implementer" };
  assert.equal(resolveTaskAssignee(task, bindings), "claude");
});

test("resolveTaskAssignee：没有字面 assignee、也没有 bindings 或没有对应能力时返回 null", () => {
  assert.equal(resolveTaskAssignee({ capability_required: "implementer" }, null), null);
  assert.equal(resolveTaskAssignee({ capability_required: "implementer" }, { capabilities: {} }), null);
  assert.equal(resolveTaskAssignee({}, { capabilities: { implementer: "claude" } }), null);
});

test("taskRequiredResources：v2 任务读 resource_contract.requires，legacy 任务兜底读 requires", () => {
  assert.deepEqual(taskRequiredResources({ resource_contract: { requires: ["shared-db"] } }), ["shared-db"]);
  assert.deepEqual(taskRequiredResources({ requires: ["shared-db"] }), ["shared-db"]);
  // v2 任务卡显式声明空数组时，不能被 legacy 字段污染（即使两者都存在，v2 优先）。
  assert.deepEqual(taskRequiredResources({ resource_contract: { requires: [] }, requires: ["should-be-ignored"] }), []);
});

test("taskForbiddenResources/taskForbiddenBehaviors：v2 任务的资源禁止项和行为禁止项分开存放", () => {
  const task = {
    resource_contract: { forbidden: ["shared-db-write"] },
    process_contract: { forbidden_behaviors: ["unreviewed-self-acceptance"] }
  };
  assert.deepEqual(taskForbiddenResources(task), ["shared-db-write"]);
  assert.deepEqual(taskForbiddenBehaviors(task), ["unreviewed-self-acceptance"]);
});

test("taskOutputs：v2 任务读 io_contract.outputs，legacy 任务兜底读 outputs", () => {
  assert.deepEqual(taskOutputs({ io_contract: { outputs: ["a.parquet"] } }), ["a.parquet"]);
  assert.deepEqual(taskOutputs({ outputs: ["a.parquet"] }), ["a.parquet"]);
});

test("renderPrompt：v2 任务的资源/禁止项/输出/验收标准都要出现在渲染出的 prompt 里，不能因为走了 v2 schema 就被渲染成空", () => {
  const task = {
    task_id: "T-v2-prompt-test",
    resource_contract: { requires: ["shared-db"], forbidden: ["source-db-write"] },
    process_contract: { forbidden_behaviors: ["unreviewed-self-acceptance"] },
    io_contract: { outputs: ["data/out.parquet"], allowed_writes: ["data/staging/**"] },
    acceptance_criteria: [{ id: "c1", description: "行数一致", check_type: "scripted", check_ref: "verify.mjs" }],
    knowledge_refs: [{ doc_id: "kd-001" }]
  };
  const prompt = renderPrompt(task, "codex");
  assert.ok(prompt.includes("shared-db"), "应包含 resource_contract.requires 里的资源");
  assert.ok(prompt.includes("source-db-write"), "应包含 resource_contract.forbidden 里的禁止资源");
  assert.ok(prompt.includes("unreviewed-self-acceptance"), "应包含 process_contract.forbidden_behaviors 里的禁止行为");
  assert.ok(prompt.includes("data/out.parquet"), "应包含 io_contract.outputs 里的预期输出");
  assert.ok(prompt.includes("行数一致"), "应包含 acceptance_criteria 里的验收标准描述");
  assert.ok(prompt.includes("kd-001"), "应包含 knowledge_refs 里的知识库文档 id");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error.stack ?? String(error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exit(1);
}
