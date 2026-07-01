# 协作规则

## 能力与身份

下面"角色分工"里对 Codex/Claude/人工负责人的具体描述，对没有 `.kiro/specs/<spec-name>/bindings.json` 的 spec 仍然逐字适用，这是祖父条款，不需要重新解释。

有 `bindings.json` 的 spec，"Codex""Claude"这些名字应理解成能力标签（architect / implementer / reviewer / tester，定义见 `.kiro/roles/`）的具体绑定，而不是固定人格。同一份 steering 规则，只是把"谁具体来做"这件事交给每个 spec 自己的 `bindings.json` 声明，角色对调应该是那份文件的一处小改动，不需要另写一份 prose 声明"不要套用现有规则"。

## 角色分工

Codex 是主要执行者。

Codex 应该：

- 把人工负责人的自然语言描述展开成需求。
- 在需求通过后起草设计。
- 在设计通过后拆分任务。
- 执行已批准的任务。
- 按 Claude 反馈修改设计、任务拆解或实现。
- 写实现说明、验证结果和交付记录。
- 遇到资源冲突、范围不清或高风险动作时停止推进，交给人工负责人裁决。

Claude 是评审、测试和反馈者。

Claude 应该：

- 自动评审 Codex 产出的 `design.md`、`tasks.md` 和后续实现 artifact。
- 检查 Codex 的产出是否满足需求、设计、任务约束和 steering。
- 运行任务指定的测试或验证。
- 写清楚评审结论、问题发现、复现方式和修改建议。
- 给出 `accepted`、`changes-requested` 或 `blocked`。
- 除非任务明确分配，否则不直接改写 Codex 负责的实现。

人工负责人是最终裁决者。

人工负责人应该：

- 确认或驳回需求。
- 在 Claude 接受设计后，最终批准或驳回设计。
- 在 Claude 接受任务拆解后，最终批准或驳回任务拆解。
- 在 Claude 接受实现后，最终验收或驳回实现。
- 裁决 Codex 和 Claude 的分歧。
- 批准高风险动作。

## 规格门禁

必须按以下顺序推进：

```text
requirements.md
  -> design.md 草案
  -> Claude 评审 design
  -> Codex 按需返工 design
  -> Claude 接受 design
  -> 人工负责人最终批准 design
  -> tasks.md 草案
  -> Claude 评审 tasks
  -> Codex 按需返工 tasks
  -> Claude 接受 tasks
  -> 人工负责人最终批准 tasks
  -> 执行队列
```

规则：

- `requirements.md` 只描述需求、边界、约束和验收标准。
- `design.md` 只在需求确认后创建。
- `tasks.md` 只在设计经过 Claude 接受且人工负责人最终批准后创建。
- 执行队列只在任务拆解经过 Claude 接受且人工负责人最终批准后生成。
- 如果人工负责人修改范围，回到最早受影响的阶段更新。
- Codex 的产出不能跳过 Claude 评审直接交给人工负责人验收，除非人工负责人明确要求紧急绕过。

## 通用评审循环

设计、任务拆解和实现都使用同一类循环：

```text
Codex 产出 -> Claude 评审/测试 -> Codex 按反馈返工 -> Claude 接受 -> 人工负责人最终裁决
```

Claude 评审结论使用：

- `accepted`
- `changes-requested`
- `blocked`

处理规则：

- `accepted`：进入人工负责人最终裁决。
- `changes-requested`：回到 Codex 返工。
- `blocked`：交给人工负责人裁决。

## 对抗式评审池（可选，需 spec 声明）

spec 的 `bindings.json` 可以为某个阶段声明 `review_pools`，把上面"Claude 评审"从单一评审换成至少 2 个独立 seat 的对抗评审：每个 seat 必须是独立的 CLI 进程/窗口，优先绑定不同底层模型，提交前不得读取其他 seat 的结论，全部 seat 提交后才按声明的聚合策略（默认 `unanimous`）算出最终结论。具体硬性规则见 `.kiro/roles/reviewer.md`。没有声明 `review_pools` 的阶段，继续走上面的单一 Claude 评审循环。

执行任务层面，人工最终验收（`human_acceptance`）必须通过独立的 `accept-task.mjs` 命令记录，绝不能和 AI 评审的 `reviews[]`/`review_status`/`reviewed_by`/`review_artifact` 共用同一批字段或同一个命令——人工点头不能覆盖 AI 评审记录。

## 资源声明

共享资源必须由具体 spec 或 task 显式声明。

规则：

- steering 不预设具体业务资源。
- task 需要资源时，必须写入 `requires`。
- task 禁止使用某资源时，必须写入 `forbidden`。
- Agent 执行前必须检查任务声明和当前锁状态。
- 未声明、未授权或有冲突的资源不得使用。
