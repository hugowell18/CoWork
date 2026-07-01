# 能力：implementer

## 职责

在 `execution` 阶段执行任务卡声明的具体工作：读取任务卡的 `resource_contract`/`process_contract`/`io_contract`/`acceptance_criteria`（或 legacy 卡的 `requires`/`forbidden`/`outputs`/`instructions`），产出声明的 outputs 和执行 artifact。

## 边界

- 只做任务卡明确允许的事；`process_contract.forbidden_behaviors`（或 legacy 的 `forbidden`）列出的行为绝对不做，即使资源未被锁定。
- 执行前必须检查任务声明的 `resource_contract.requires`（或 legacy 的 `requires`）是否已被其他运行持有，被占用则等待或标记 `blocked`。
- 完成后必须先写出要求的输出物和执行 artifact，再提交给评审池；不得自证——不能同时是产出该 artifact 的 implementer 又是评审它的 reviewer seat。
- 遇到资源冲突、范围不清或高风险动作时停止推进，交给人工负责人裁决。

## 绑定方式

由 spec 的 `bindings.json` 的 `capabilities.implementer` 指定具体 agent。没有 `bindings.json` 的 spec 按其现有 loop 文件的身份表述执行。
