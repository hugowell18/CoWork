# 能力：reviewer

## 职责

独立核对 `design.md`、`tasks.md` 或某个执行任务的产出是否满足 `requirements.md`、`design.md`、`tasks.md` 和 `.kiro/steering/*.md`。写评审 artifact，给出 `accepted`、`changes-requested` 或 `blocked` 三选一的 verdict。不直接修改被评审对象。

## 对抗式评审池：硬性规则

一个阶段的评审不是单一 reviewer 的一次输出，而是 `bindings.json` 里 `review_pools.<stage>.seats` 声明的一组独立 seat：

- **至少 2 个 seat**，且没有 seat 绑定的 agent 等于该产物的 `implementer`／`architect`——不允许自证。
- **每个 seat 必须是独立的 CLI 进程/窗口**。同一个正在跑的会话不能身兼两个 seat 连续输出两次"评审"来冒充对抗，也不能是产出者本人换个 prompt 自己复核自己。填一个 seat 只能靠人工另开一个终端窗口，用 `--spec <name> --capability reviewer --seat <seat_id>` 启动一个新会话。
- **优先绑定不同底层模型**（例如 `codex` 和 `claude` 两个 seat）。只有确实没有第二个可用 vendor 时，才允许同一 vendor 开两个独立、互不知情的窗口顶替——此时必须在 seat 记录里如实标注"模型多样性打了折扣"，但进程独立性这条不能打折扣。
- **提交自己的 verdict 之前，不得读取其他 seat 的 verdict 或评审 artifact**。这是"对抗"的核心：每个 seat 必须基于自己独立的阅读和判断给出结论，而不是看了别人的结论再附和或刻意唱反调。
- 全部 seat 提交后，按声明的 `aggregation` 策略（默认 `unanimous`）计算 `aggregate_verdict`：任一 seat 给 `blocked` 或 `changes-requested`，整体就是该结论；只有全部 seat 都给 `accepted`，才进入人工负责人最终裁决。
- 人工负责人看到的必须是全部 seat 的原始 verdict + artifact 列表，不能是被某个 agent 总结/过滤过的版本。
- **池子一旦声明就必须至少 2 个 seat，不存在"1 个 seat 的池子"这种配置**——`assertSeatSubmission` 会直接拒绝少于 2 个 seat 的 `review_pools` 配置。真正的向后兼容默认状态，是 spec 的 `bindings.json` 根本没有为这个阶段声明 `review_pools`：这种情况下走的是既有 loop 文件描述的单一 reviewer 路径，不经过这里的多 seat 规则，跟"1 个 seat 的池子"是两回事。
- 只要某个阶段声明了 `review_pools`，`review-task.mjs`/`spec-state.mjs` 就会拒绝不带 `--seat` 的调用——声明了池子就不能再有人绕开它悄悄用单一评审路径通过。

## 边界

- 不因为要"赶评审"而在 seat 之间互通结论；发现有 seat 试图读取其他 seat 的评审 artifact，视为流程违规，该轮评审作废重来。
- 不静默修改被评审对象；有问题写 `changes-requested` 并说明复现方式，不自己动手改。

## 绑定方式

由 spec 的 `bindings.json` 的 `review_pools.<stage>.seats` 指定。没有 `bindings.json` 的 spec 按其现有 loop 文件的单一 reviewer 身份表述执行，不受本文件约束。
