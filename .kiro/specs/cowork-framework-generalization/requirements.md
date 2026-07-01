# 需求：cowork-framework-generalization

## 状态

`approved`（人工负责人已在会话中通过 plan 确认本 spec 的 requirements 与 design 内容，approved_at 见 `state.json`）。

## 背景

Cowork 早期的协作机制（`.kiro/agents/*-loop.md`、`tools/ai-coord/*`、`.kiro/steering/product.md`/`collaboration.md`）把"谁执行、谁评审"硬编码成字面身份（`codex`/`claude`），把"下一步该谁上"写死在逐 spec 手写的 loop 文件里。这在只服务一个业务、两个固定 CLI 的阶段没有暴露问题，但出现过具体的腐化证据：loop 文件曾长期指向已经关闭的旧 spec；某个业务 spec 需要角色对调时，只能靠大段 prose 声明"不要套用现有 loop 文件"，并手改 `state.json` 成状态机自己都不认识的形状。

人工负责人希望把 Cowork 改造成通用工程：角色变成能力标签动态绑定而不是固定人格；每个阶段的评审是真正的多模型/多 CLI 窗口对抗，而不是同一个会话换个 prompt 假装是两个评审人；worker 之间靠契约文件交互，不靠聊天；新增类似 RAG 的知识库，检索项目参考资料以固化产出质量；需求确认到任务拆解要能支持更细粒度分解。

## 需求 1：能力角色必须独立于具体 agent 身份

系统应该把"谁做什么"表达成能力标签（architect/implementer/reviewer/tester 等），而不是把 Codex/Claude 的名字直接写进 steering 或状态机默认值。

验收标准：

- 新增 `.kiro/roles/capabilities.json` 作为能力目录，新增能力只需要追加条目，不需要改代码。
- 每个 spec 通过自己的 `bindings.json` 声明"这次谁扮演哪个能力"，角色对调应该是这份文件的一处小改动，而不是一份新 loop 文件或大段 prose 声明。
- `.kiro/steering/product.md`/`collaboration.md` 里"Codex 是主要执行者"这类身份表述改写为能力表述，并附祖父条款：没有 `bindings.json` 的 spec 继续按其现有 loop 文件的身份表述运行，不受影响。

## 需求 2：评审必须是不同 CLI 窗口/不同模型的对抗，而非同一会话的自我复核

系统应该保证一个阶段的评审来自至少两个相互独立、互不知情的 CLI 会话，优先跨模型（Codex 与 Claude），聚合后才进入人工裁决。

验收标准：

- `bindings.json` 的 `review_pools` 为每个阶段声明至少 2 个 seat，且没有 seat 绑定的 agent 等于该产物的 `implementer`（禁止自证）。
- 各 seat 必须是独立的 CLI 进程/窗口；协议文档必须明确写出"提交自己 verdict 前不得读取其他 seat 的 verdict/artifact"的独立性要求。
- 优先绑定不同底层模型；只有在没有第二个可用 vendor 时，才允许同一 vendor 开两个独立会话顶替，且需要如实标注这一点（模型多样性打了折扣，但流程独立性不能打折扣）。
- 聚合策略默认为 `unanimous`：任一 `blocked`/`changes-requested` 则整体不通过，全部 `accepted` 才进入人工裁决；人工看到的是全部 seat 的原始 verdict + artifact，不是被总结过滤的版本。
- 只有 1 个 reviewer seat 时（即 spec 没有为该阶段声明 `review_pools`），聚合结果必须与单一 reviewer 的行为逐字节一致（向后兼容）。

## 需求 3：任务契约必须区分资源锁、流程规则、验收标准和知识引用

系统应该把任务卡里目前混在一起的"资源锁"和"角色/流程边界规则"拆开，并把自由 prose 的 `instructions` 补充为可核对的验收点。

验收标准：

- 新任务卡可以携带 `contract_version: 2`，新增字段拆分为 `resource_contract`（纯资源锁）、`process_contract`（纯行为边界规则）、`io_contract`、`acceptance_criteria`（结构化验收点）、`knowledge_refs`。
- 没有 `contract_version` 的既有任务卡保持现在的扁平字段读法，不需要回填。
- 人工最终验收（`human_acceptance`）必须与 AI 评审记录（`reviews[]`）是相互独立的字段和独立命令，禁止复用同一套字段——这条直接来自一次真实发生过的事故：某张历史任务卡里，人工验收和 AI 评审共用同一批字段，人工验收把 AI 评审记录覆盖掉了。
- 任务卡涉及的资源锁检查、prompt 渲染、领取时写回的元数据，都必须能正确读取 `contract_version: 2` 的嵌套字段，不能只兼容顶层扁平字段——这条同样来自真实教训：第一版实现只加了 schema 和能力解析，锁检查/prompt 渲染仍然只读 legacy 字段，导致 v2 任务卡声明的资源锁需求被静默忽略。

## 需求 4：调度机制必须按 spec 隔离，不能互相阻塞

系统应该保证一个 spec 里等待评审的任务不会阻塞其他 spec 的任务分配。

验收标准：

- `next-task.mjs`、`status.mjs` 支持可选 `--spec` 参数；传入时只在该 spec 范围内判断 `awaiting-review` 门禁和候选任务。
- 不传 `--spec` 时保持现有全局行为不变（向后兼容，默认值等价于今天的实现）。

## 需求 5：新增知识库供起草和评审前检索参考资料

系统应该提供一个按 spec 隔离的、只读的参考资料检索层，起草者和评审者在产出设计/任务前可以查询。

验收标准：

- 每个 spec 可以有 `knowledge/manifest.json` 登记参考文档（id/title/tags/source/path）。
- 提供关键词/全文检索命令，不引入 embedding 或向量库依赖。
- `source: "external"`（指向本仓库之外的路径，例如另一个姊妹仓库）只按 title/tags 匹配，不假设文件在当前系统可读。
- 知识库是只读输入，不能绕过评审门禁直接产出结论；任务契约的 `knowledge_refs` 应可被评审者核对"是否查过、查到了什么"。

## 需求 6：既有 spec 不受影响

任何本次改造都不能改变既有 spec 现有文件的内容，或既有工具在不传新参数时的行为。

验收标准：

- 涉及共享脚本（`core.mjs`、`next-task.mjs`、`spec-state.mjs`、`review-task.mjs`、`finish-task.mjs`、`status.mjs`）的改动必须是向后兼容的：新逻辑只在检测到 `bindings.json`/`contract_version` 等新标记存在时才生效。
- 每个涉及共享脚本的阶段完成后，必须对既有 spec 的任务卡跑一遍相关命令，确认输出与改造前一致。

## 实施分期

沿用 Cowork 一贯的低风险分期习惯，具体分期、文件改动和验证方式见同目录 `design.md` 和 `tasks.md`。

## 当前需求决策

1. 本 spec 由人工负责人直接与 Claude 对齐 requirements/design（角色特例，不强制走"Codex 起草、Claude 评审"两段式）。
2. `tasks.md` 中的任务分期即执行顺序；后续阶段如需调整范围，由人工负责人直接决定并更新 `state.json`。
