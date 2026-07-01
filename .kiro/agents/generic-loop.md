# Generic Loop 启动说明

你是被指派了某个能力（capability）的 agent，当前工程根目录是当前工作目录。这是所有新 spec 共用的通用 loop 协议，取代逐 spec 手写的 loop 文件。

## 启动参数

启动时需要知道两件必备信息和一个可选信息：

- `--spec <spec-name>`：当前要跟随的 spec，对应 `.kiro/specs/<spec-name>/`。
- `--capability <capability-id>`：本次会话在这个 spec 里扮演的能力（`architect` / `implementer` / `reviewer` / `tester`，定义见 `.kiro/roles/`）。
- 可选 `--seat <seat_id>`：只有当这个 spec 的 `bindings.json` 为当前阶段声明了 `review_pools` 且你是其中一个 reviewer/tester seat 时才需要。

这三者应该和 spec 的 `.kiro/specs/<spec-name>/bindings.json` 一致——如果 `bindings.json` 里 `capabilities.<capability>` 指定的 agent 不是你自己，先停下来跟人工负责人确认，不要继续执行。没有 `bindings.json` 的 spec 只能按其自己的说明运行，不适用本文件。

## 固定职责

- 读取 `.kiro/steering/*.md`。
- 读取 `.kiro/specs/<spec-name>/{requirements.md, design.md, tasks.md, state.json, bindings.json}`（后三者如果存在）。
- 只做 state 允许你当前能力在当前阶段做的事情。
- 不跳过评审；如果 `bindings.json` 为当前阶段声明了 `review_pools`，必须用 `--seat` 提交评审，不能走单一评审路径（工具会拒绝不带 `--seat` 的调用）。
- 不静默修改不属于自己能力范围的产出物；有问题走评审反馈，不自己动手改。

## 当前循环

每一轮都先运行：

```shell
node tools/ai-coord/spec-state.mjs show --spec <spec-name>
```

### architect 能力（requirements / design / tasks 阶段）

如果对应阶段 `status` 是 `ready-to-draft` 或 `changes-requested`：

1. 起草或按评审反馈修改对应文档（`requirements.md` / `design.md` / `tasks.md`）。起草前先用知识库检索一下有没有相关参考资料（见下面"知识库"一节）。
2. 完成后运行对应命令进入评审：

```shell
node tools/ai-coord/spec-state.mjs requirements-ready --spec <spec-name>
node tools/ai-coord/spec-state.mjs design-ready --spec <spec-name>
node tools/ai-coord/spec-state.mjs tasks-ready --spec <spec-name>
```

3. 等待评审结论，不要在评审通过前继续修改。

### reviewer 能力（对 requirements / design / tasks 或某个执行任务做评审）

如果对应阶段 `status` 是 `waiting-claude-review`（这个状态名是历史遗留，代表"等待评审"，不代表只有 Claude 能评审）：

1. 读取待评审文档，对照 `requirements.md` / `design.md` / `tasks.md` / `.kiro/steering/*.md` 独立评审。
2. 写评审 artifact 到 `.ai-coord/artifacts/<spec-name>/<stage>-review-r<revision>.md`；如果是多 seat 池子，用 `<stage>-review-<seat_id>-r<revision>.md` 区分不同 seat 的产出。
3. 提交结论：

```shell
# 没有声明 review_pools 的阶段：
node tools/ai-coord/spec-state.mjs requirements-review --spec <spec-name> --verdict <accepted|changes-requested|blocked> --artifact <path>

# 声明了 review_pools 的阶段，必须加 --seat 和 --agent：
node tools/ai-coord/spec-state.mjs design-review --spec <spec-name> --seat <seat_id> --agent <你自己> --verdict <accepted|changes-requested|blocked> --artifact <path>
```

4. **提交自己的 verdict 之前，不得读取其他 seat 的评审 artifact**——如果你被分配了某个 seat，必须基于自己独立的阅读和判断给出结论。

### implementer 能力（execution 阶段）

如果 `phase` 是 `execution`：

1. 运行 `node tools/ai-coord/status.mjs --spec <spec-name>` 查看任务队列。
2. 如果有分配给你的 `changes-requested` 任务，先返工（返工前先读评审 artifact）：

```shell
node tools/ai-coord/next-task.mjs --agent <你自己> --spec <spec-name>
```

3. 否则领取下一个任务，遵守任务卡的契约——v2 任务卡看 `resource_contract` / `process_contract` / `io_contract` / `acceptance_criteria`，legacy 任务卡看 `requires` / `forbidden` / `outputs` / `instructions`。执行前必须检查 `resource_contract.requires`（或 legacy `requires`）声明的资源是否已被其他运行持有。
4. 完成后先写出要求的输出物和执行 artifact，再运行：

```shell
node tools/ai-coord/finish-task.mjs --agent <你自己> --task <task-id> --status done
```

### tester 能力

按任务卡 `acceptance_criteria` 里 `check_type: "scripted"` 的项，运行声明的验证命令（`check_ref`），如实汇报 pass/fail 和证据；结果计入你对应的 reviewer/tester seat 评审提交，不擅自扩大验证范围到未声明的资源。

## 人工验收

如果任务卡的 `process_contract.requires_human_acceptance` 是 `true` 且状态已经是 `awaiting-human-acceptance`，只有人工负责人可以运行：

```shell
node tools/ai-coord/accept-task.mjs --agent <human-identity> --task <task-id> --decision <accepted|rejected> --artifact <path>
```

任何 AI agent 都不能代替人工负责人调用这个命令，也不能在状态还是 `awaiting-review`（评审未完成）时提前验收。

## 知识库

起草 `design.md` / `tasks.md` 或执行任务前，先查一下这个 spec 有没有相关参考资料：

```shell
node tools/ai-coord/knowledge-search.mjs --spec <spec-name> --query "<关键词>"
```

如果任务卡声明了 `knowledge_refs`，评审时会被核对是否真的查过对应文档。

## 等待方式

需要等待时使用跨平台 Node sleep：

```shell
node -e "setTimeout(()=>{},10000)"
```

然后重新检查状态。
