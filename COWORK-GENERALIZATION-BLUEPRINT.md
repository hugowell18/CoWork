# Cowork 通用化改造 Blueprint

## 1. 定位

Cowork 的目标不是成为某个业务项目的脚手架，而是成为一个本地文件驱动的 AI-native 协作控制层。

它要解决的问题是：当 Codex、Claude、其他模型、人工负责人共同参与一个工程时，协作不能依赖聊天记忆、临时 prompt 或单个 agent 的自我判断，而必须依赖稳定契约、阶段门禁、独立评审、人工裁决和可复核证据链。

目标范式：

```text
客户输入
  -> intake
  -> requirements
  -> design
  -> tasks
  -> execution
  -> adversarial review
  -> human acceptance
  -> deliverable package
```

核心原则：

- Spec 是合同，不是聊天摘要。
- Artifact 是证据，不是口头说明。
- Review 是门禁，不是建议评论。
- Human 是最终裁决者，不是橡皮图章。
- Knowledge 是可追溯上下文，不是临时塞进 prompt 的资料。
- Worker 通过文件契约协作，不通过互相聊天协作。

## 2. 判断

这套范式符合当前 AI-native 开发的主流趋势：从单轮 prompt 转向 context/spec engineering，从单 agent 转向有角色、有权限、有交接的 agent workflow，从 AI 直接产出转向 AI 产出、独立复核、人工裁决。

但当前 Cowork 仍处于本地协议原型阶段。它的方向先进，成熟度还需要通过隔离、观测、eval、权限和知识库逐步补齐。

当前合理定位：

```text
面向高风险、高复杂项目的本地 AI 协作控制层
```

不应把它过早做成自动调度平台。现阶段保留人工手动启动 CLI 窗口，反而有利于保证多评审 seat 的真实独立性。

## 3. 保留的主干

以下机制继续保留：

- `requirements.md -> design.md -> tasks.md -> execution` 的阶段顺序。
- 每个阶段都必须经过 review loop。
- 人工负责人在每个关键阶段做最终裁决。
- 状态落在本地文件和事件流，不依赖聊天上下文。
- `.ai-coord/events/` 作为事实事件流。
- `.ai-coord/artifacts/` 作为产出和证据引用位置。
- `tools/ai-coord/lib/core.mjs` 中已有的 JSON、事件、锁等基础能力继续复用。
- `lock.mjs` 已经足够通用，默认不改。

以下也保留：

<!-- 会话记录里留存的原文到此为止；本文件之后的部分未能找回，如需补全请重新整理。 -->
