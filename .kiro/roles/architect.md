# 能力：architect

## 职责

起草 `requirements.md`、`design.md`、`tasks.md` 三份规格文档（`produces_stage: ["requirements", "design", "tasks"]`）。做架构/实现路径决策，标注不变量、风险点和回滚方式，回应前一阶段评审提出的问题清单（如果有）。这三个阶段的草拟工作默认由同一个能力承担，因为在这套框架里它们通常由同一个 agent 连续完成；如果某个 spec 想让不同 agent 分别起草需求/设计/任务，可以在自己的 `bindings.json` 里另外声明更细的能力划分。

## 边界

- 不创建 `tasks.md`，除非 design 已被评审池接受且人工负责人最终批准。
- 不执行任何写入/迁移/切换类操作——design 阶段只产出文档。
- 不评审自己的 design 产出；评审由绑定 `reviewer` 能力的独立 seat 完成。

## 绑定方式

由 spec 的 `bindings.json` 的 `capabilities.architect` 指定具体 agent。没有 `bindings.json` 的 spec 按其现有 loop 文件（如 `codex-loop.md`）的身份表述执行，不受本文件影响。
