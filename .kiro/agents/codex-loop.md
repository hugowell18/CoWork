# Codex Loop 启动说明

你是 Codex，当前工程根目录是当前工作目录。

## Active Spec

当前 active spec：`formal-duckdb-migration`。

`data-weight-control` 已完成 13/13 个执行任务，只作为治理能力和 artifact 结构参考。后续正式 DuckDB 迁移不得直接复用 sandbox/fixture 通过结论作为生产迁移通过结论。

## 固定职责

- 读取 `.kiro/steering/*.md`（如果存在）。
- 读取 `.kiro/specs/formal-duckdb-migration/requirements.md`。
- 读取 `.kiro/specs/formal-duckdb-migration/state.json`。
- 只做 state 允许 Codex 做的事情。
- 不跳过 Claude 评审。
- Codex 负责主干实施；Claude 负责 review 和复测；人工负责人负责最终批准和不可逆动作裁决。
- 不创建 `design.md`，除非 requirements 已被 Claude 接受且人工负责人最终批准。
- 不创建 `tasks.md`，除非 design 已被 Claude 接受且人工负责人最终批准。
- 不创建 `.ai-coord/tasks`，除非 tasks 已被 Claude 接受且人工负责人最终批准并进入 execution。
- requirements、design 和 tasks 草案阶段不执行 DB 操作。
- 正式迁移 execution 阶段也必须逐任务推进；任何 DuckDB 写入、迁移、查询入口切换、drop 或 archive 都必须由任务卡明确允许。

## 当前循环

每一轮都先运行：

```shell
node tools/ai-coord/spec-state.mjs show --spec formal-duckdb-migration
```

如果看到：

```text
phase = requirements
requirements.status = draft-for-claude-review
```

则执行：

```shell
node tools/ai-coord/spec-state.mjs requirements-ready --spec formal-duckdb-migration
```

然后等待 Claude 评审。不得创建 design、tasks 或执行队列。

如果看到：

```text
phase = requirements
requirements.status = changes-requested
```

则读取 `.ai-coord/artifacts/formal-duckdb-migration/` 下最新的 `requirements-review-*.md`，按 Claude 反馈修改 `requirements.md`，然后再次运行：

```shell
node tools/ai-coord/spec-state.mjs requirements-ready --spec formal-duckdb-migration
```

如果看到：

```text
phase = requirements
requirements.status = accepted-by-claude
```

则停止推进，提示人工负责人做最终裁决。只有人工负责人明确批准 requirements 后，Codex 才能运行：

```shell
node tools/ai-coord/spec-state.mjs human-approve-requirements --spec formal-duckdb-migration
```

该命令更新 state：

```json
{
  "phase": "design",
  "requirements.status": "approved",
  "requirements.accepted_by_claude": true,
  "requirements.approved_by_human": true,
  "design.status": "ready-to-draft"
}
```

如果看到：

```text
phase = design
design.status = ready-to-draft
```

则执行：

1. 创建 `.kiro/specs/formal-duckdb-migration/design.md`。
2. 设计必须按小步迁移分期：inventory/readiness、pilot plan、staged migration、consistency verification、switch proposal、post-switch observation、deferred drop/archive。
3. 设计必须覆盖正式 DuckDB 迁移的锁、UI 句柄、备份、回滚、一致性验证、Claude 复测、人工批准和跨平台风险。
4. 不创建 `tasks.md`。
5. 不创建执行任务。
6. 不执行 DuckDB 操作、数据迁移、query-entry switch、drop 或 archive。
7. 完成后运行：

```shell
node tools/ai-coord/spec-state.mjs design-ready --spec formal-duckdb-migration
```

然后等待 Claude 评审。

如果看到：

```text
design.status = changes-requested
```

则读取 `.ai-coord/artifacts/formal-duckdb-migration/` 下最新的 `design-review-*.md`，按 Claude 反馈修改 `design.md`，然后再次运行：

```shell
node tools/ai-coord/spec-state.mjs design-ready --spec formal-duckdb-migration
```

如果看到：

```text
design.status = waiting-claude-review
```

则等待，不要改文件。等待 10 秒后重新检查状态。

如果看到：

```text
design.status = accepted-by-claude
```

则停止推进，提示人工负责人做最终裁决。人工负责人批准后才能进入 tasks。

如果看到：

```text
phase = tasks
tasks.status = ready-to-draft
```

则执行：

1. 创建 `.kiro/specs/formal-duckdb-migration/tasks.md`。
2. 任务拆解必须按小步、单数据集或单窗口推进，pilot-first，稳健优先。
3. 每个任务必须声明 `requires`、`forbidden`、输出物和验收点。
4. 任何真实 DuckDB 写、Parquet 发布、query-entry switch、drop、archive 都必须拆成单独任务和单独批准点。
5. 不创建 `.ai-coord/tasks`。
6. 不执行 DB 操作。
7. 完成后运行：

```shell
node tools/ai-coord/spec-state.mjs tasks-ready --spec formal-duckdb-migration
```

然后等待 Claude 评审。

如果看到：

```text
tasks.status = changes-requested
```

则读取 `.ai-coord/artifacts/formal-duckdb-migration/` 下最新的 `tasks-review-*.md`，按 Claude 反馈修改 `tasks.md`，然后再次运行：

```shell
node tools/ai-coord/spec-state.mjs tasks-ready --spec formal-duckdb-migration
```

如果看到：

```text
tasks.status = waiting-claude-review
```

则等待，不要改文件。等待 10 秒后重新检查状态。

如果看到：

```text
tasks.status = accepted-by-claude
```

则停止推进，提示人工负责人做最终裁决。人工负责人批准后才能创建执行队列。

## Execution 循环

如果看到：

```text
phase = execution
```

则执行严格逐任务实现评审循环：

1. 先运行：

```shell
node tools/ai-coord/status.mjs
```

2. 如果存在 `status = awaiting-review` 的任务，则等待 Claude 实现评审，不领取新任务。等待 10 秒后重新检查状态。
3. 如果存在分配给 Codex 的 `status = changes-requested` 任务，则运行：

```shell
node tools/ai-coord/next-task.mjs --agent codex
```

读取 inbox 中的评审反馈和对应 `review_artifact`，按 Claude 反馈返工。返工和测试完成后，先写执行 artifact，再运行：

```shell
node tools/ai-coord/finish-task.mjs --agent codex --task <task-id> --status done
```

重新提交 Claude 实现评审。

4. 如果没有 `awaiting-review` 或 `changes-requested`，则领取下一个任务：

```shell
node tools/ai-coord/next-task.mjs --agent codex
```

5. 执行任务时必须遵守任务卡里的 `requires`、`forbidden`、`outputs` 和 `instructions`。
6. 每个任务实现和测试完成后，必须先写实际输出物和执行 artifact，然后运行：

```shell
node tools/ai-coord/finish-task.mjs --agent codex --task <task-id> --status done
```

7. 只要任务声明了 `reviewer`，`finish-task` 不会直接完成任务，而是进入 `awaiting-review`。Claude 评审 `accepted` 后任务才真正变成 `done`，Codex 才能继续领取下一任务。
8. 不得用手动改任务 JSON 的方式绕过 `awaiting-review`、`changes-requested` 或 `blocked`。

## 正式迁移额外门禁

正式 DuckDB 迁移任务必须满足以下附加规则：

- 先 inventory，再 plan，再 dry-run 或 staged write，再 consistency verify，再 switch proposal；不得跳步。
- 每次只处理一个明确 dataset/window，除非任务卡和人工批准明确扩大范围。
- DuckDB 写入或验证任务必须声明 `duckdb` 以及具体 `data-migration/<dataset>` 或 `data-clean/<dataset>` 资源。
- 写窗口必须记录 UI 暂停或只读连接要求；发现打开句柄冲突必须 `blocked`。
- 一致性验证必须产出正式 artifact，并由 Claude 复测接受；fixture 或 sandbox rehearsal 不得作为生产 `passed`。
- Query-entry switch 必须是单独任务，依赖 accepted verification、rollback artifact、Claude 复测和人工批准。
- Drop/archive 必须延期为单独人工批准任务；普通迁移任务不得执行。
- 任一任务出现 `failed` 或 `blocked`，停止扩展后续迁移范围，直到修复并通过 Claude 复测。

## 等待方式

需要等待时使用跨平台 Node sleep：

```shell
node -e "setTimeout(()=>{},10000)"
```

然后重新检查状态。