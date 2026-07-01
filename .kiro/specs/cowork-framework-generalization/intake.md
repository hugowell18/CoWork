# Intake: cowork-framework-generalization

## 目标

Cowork 最初是为服务某一个具体业务项目而手搭的一次性协作脚手架，本次把它改造成可复用于任意新客户/新项目的通用规格驱动多 Agent 协作框架：换一个项目，只需要写 requirement、配一份 `bindings.json`，就能复用同一套 requirement→design→task→execution 门禁、评审机制和知识库机制，不需要重新手写协作规则。

## 干系人

- 人工负责人（本工程唯一最终裁决者）：确认本 spec 的 requirements/design/tasks，批准每个阶段。
- Codex：本次改造的主干实施者之一（视具体任务分配）。
- Claude：本次改造的评审/复测者之一（视具体任务分配）；本 spec 的 requirements/design 由 Claude 直接与人工负责人对齐产出——这是本框架已经用过的一种角色特例模式：某些场景下人工负责人可以选择跳过标准的"Codex 起草、Claude 评审"两段式，直接指定其中一个能力的具体承担者。

## 约束

- 任何新增机制都必须向后兼容：已有 spec 现有文件的内容、既有工具在不传新参数时的行为，都不能被改变。
- 不引入 daemon、调度器或自动唤醒机制——人工仍手动开启 Codex CLI / Claude CLI 会话；对抗评审新增的"多 seat"要求，本质上要求人工手动开多个独立会话窗口，而不是靠单一会话自动化。
- 跨平台（Windows/macOS）约束延续 `tech.md` 现有规则，新增内容不得引入操作系统专属路径假设。
- 不新增运行时依赖（不引入 embedding/向量库、不引入测试框架），优先复用 Node 内置能力和仓库已有的 `tools/ai-coord/lib/core.mjs`。

## 禁止事项

- 不给 `state.json` 做强 JSON Schema 校验（灵活表达阶段跳跃等特殊情况的能力比强校验更重要）。
- 不做语义/向量检索、不做任务体量自动拆分强制校验——两者都是留观察的后续可选项。

## 期限

无硬性截止日期；按 `.kiro/steering/tech.md` 的"低风险、早出价值"原则分期交付，每个阶段结束都有独立验证点，人工负责人可以随时暂停或调整后续阶段范围。

## 需求来源

本 spec 的 requirements/design 内容直接来自人工负责人与 Claude 在会话中已经过 `EnterPlanMode`/`ExitPlanMode` 确认的改造方案（含一次针对"评审对抗必须是不同 CLI 窗口/不同模型"的修正，以及两轮独立 review 发现并修复的问题，详见 `state.json`）。
