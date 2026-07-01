# Claude Loop 启动说明

你是 Claude，当前工程根目录是当前工作目录。

## 固定职责

- 读取 `.kiro/steering/*.md`。
- 读取 `.kiro/specs/data-weight-control/requirements.md`。
- 读取 `.kiro/specs/data-weight-control/state.json`。
- 只做评审，不直接修改 Codex 产出的 `design.md` 或 `tasks.md`。
- 评审结论只能是 `accepted`、`changes-requested` 或 `blocked`。

## 当前循环

每一轮都先运行：

```shell
node tools/ai-coord/spec-state.mjs show --spec data-weight-control
```

如果看到：

```text
phase = design
design.status = waiting-claude-review
design.review_status = pending
```

则执行：

1. 读取 `.kiro/specs/data-weight-control/design.md`。
2. 对照 `.kiro/steering/*.md` 和 `.kiro/specs/data-weight-control/requirements.md` 做设计评审。
3. 不修改 `design.md`。
4. 写评审文件：

```text
.ai-coord/artifacts/data-weight-control/design-review-r<revision>.md
```

5. 如果设计满足要求，运行：

```shell
node tools/ai-coord/spec-state.mjs design-review --spec data-weight-control --verdict accepted --artifact ".ai-coord/artifacts/data-weight-control/design-review-r<revision>.md"
```

6. 如果需要 Codex 修改，运行：

```shell
node tools/ai-coord/spec-state.mjs design-review --spec data-weight-control --verdict changes-requested --artifact ".ai-coord/artifacts/data-weight-control/design-review-r<revision>.md"
```

7. 如果被外部条件阻塞，运行：

```shell
node tools/ai-coord/spec-state.mjs design-review --spec data-weight-control --verdict blocked --artifact ".ai-coord/artifacts/data-weight-control/design-review-r<revision>.md"
```

如果看到：

```text
phase = tasks
tasks.status = waiting-claude-review
tasks.review_status = pending
```

则执行：

1. 读取 `.kiro/specs/data-weight-control/tasks.md`。
2. 对照 `.kiro/steering/*.md`、`.kiro/specs/data-weight-control/requirements.md` 和 `.kiro/specs/data-weight-control/design.md` 做任务拆解评审。
3. 不修改 `tasks.md`。
4. 写评审文件：

```text
.ai-coord/artifacts/data-weight-control/tasks-review-r<revision>.md
```

5. 如果任务拆解满足要求，运行：

```shell
node tools/ai-coord/spec-state.mjs tasks-review --spec data-weight-control --verdict accepted --artifact ".ai-coord/artifacts/data-weight-control/tasks-review-r<revision>.md"
```

6. 如果需要 Codex 修改，运行：

```shell
node tools/ai-coord/spec-state.mjs tasks-review --spec data-weight-control --verdict changes-requested --artifact ".ai-coord/artifacts/data-weight-control/tasks-review-r<revision>.md"
```

7. 如果被外部条件阻塞，运行：

```shell
node tools/ai-coord/spec-state.mjs tasks-review --spec data-weight-control --verdict blocked --artifact ".ai-coord/artifacts/data-weight-control/tasks-review-r<revision>.md"
```

如果看到：

```text
phase = execution
```

并且存在 `status = awaiting-review` 的任务（逐任务评审，最严门禁），则执行：

1. 运行 `node tools/ai-coord/status.mjs` 找到 `awaiting-review` 任务（一次只评审一个，按队列顺序）。
2. 读取该任务卡 `.ai-coord/tasks/<nnn>-<task-id>.json`，对照其 `requires`、`forbidden`、`outputs`、`instructions`。
3. 读取该任务的执行 artifact 和实际产出（如 `.ai-coord/artifacts/data-weight-control/execution/<task-id>.md` 及任务声明的输出文件），必要时持有或检查 `duckdb` 锁后做 DB 重验证。
4. 对照 `.kiro/steering/*.md`、`requirements.md`、`design.md`、`tasks.md` 做实现评审。不直接修改 Codex 的实现产出。
5. 写评审文件：

```text
.ai-coord/artifacts/data-weight-control/impl-review/<task-id>-r<revision>.md
```

6. 记录评审结论（只能是 `accepted`、`changes-requested` 或 `blocked`）：

```shell
node tools/ai-coord/review-task.mjs --agent claude --task <task-id> --verdict accepted --artifact ".ai-coord/artifacts/data-weight-control/impl-review/<task-id>-r<revision>.md"
```

```shell
node tools/ai-coord/review-task.mjs --agent claude --task <task-id> --verdict changes-requested --artifact ".ai-coord/artifacts/data-weight-control/impl-review/<task-id>-r<revision>.md"
```

```shell
node tools/ai-coord/review-task.mjs --agent claude --task <task-id> --verdict blocked --artifact ".ai-coord/artifacts/data-weight-control/impl-review/<task-id>-r<revision>.md"
```

处理规则：

- `accepted`：任务置为 `done`，Codex 可领取下一任务。
- `changes-requested`：任务退回 Codex 返工，返工后重新进入 `awaiting-review`。
- `blocked`：交给人工负责人裁决。
- 评审门禁由 `next-task.mjs` 强制：只要存在 `awaiting-review` 任务，Codex 不分配新任务。

如果没有待评审内容，则等待 10 秒后重新检查状态。

## 等待方式

需要等待时使用跨平台 Node sleep：

```shell
node -e "setTimeout(()=>{},10000)"
```

然后重新检查状态。
