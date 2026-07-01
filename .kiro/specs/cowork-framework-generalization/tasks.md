# 任务拆解：cowork-framework-generalization

## 状态

`approved`（人工负责人已通过 plan 确认里程碑顺序；M0-M4 已完成并经两轮独立 review 加固，见 `state.json`）。

## 执行方式说明

本 spec 由 Claude 在单一会话中直接实现（角色特例），不通过 `next-task.mjs` 异步领取任务。下面的里程碑列表本身就是执行顺序，进度用会话内的任务列表跟踪，不额外创建 `.ai-coord/tasks/*.json` 队列文件。

## 全局不变量

- 每个里程碑完成后跑 `npm run coord:check`。
- 涉及共享脚本的里程碑（M3、M4）必须验证对既有 spec 任务卡的调用保持逐字节兼容，否则该里程碑视为未完成。
- 任何里程碑都不得修改既有 spec 的现有文件。

## M0：即时修复（已完成）

- 修正过期的 loop 文件 `--spec` 指向；刷新 `README.md` 到当时的现状。
- 说明：这一步修复的具体业务 loop 文件（`codex-loop.md`/`claude-loop.md`）后来在仓库拆分成模板分支时被整体移除，由 `generic-loop.md` 取代；`README.md` 也在拆分时重写为模板说明。这里保留作为历史记录。

验收：两个文件不再包含过期/错误的 spec 引用。

## M1：meta-spec 落盘（已完成）

- 创建 `.kiro/specs/cowork-framework-generalization/{intake.md,requirements.md,design.md,tasks.md,state.json}`。

验收：五个文件存在且内容与已批准的改造方案一致；`state.json` 反映 requirements/design/tasks 均已批准，phase 进入 execution。

## M2：能力角色目录 + schema 文件 + 知识库脚本（已完成，纯增量）

- `.kiro/roles/capabilities.json` + `{architect,implementer,reviewer,tester}.md`。
- `.ai-coord/schemas/{task-card,knowledge-manifest}.schema.json`。
- `tools/ai-coord/knowledge-search.mjs`：关键词/全文检索，`source:"inline"` 全文索引，`source:"external"` 只按 title/tags 匹配。
- `tools/ai-coord/self-test.mjs`：纯 Node 断言（无新依赖），覆盖 `core.mjs` 的锁/任务读写辅助函数。
- `package.json` 的 `coord:check` 追加 `self-test.mjs` 的 `node --check`，另加 `coord:self-test`、`coord:knowledge` 脚本入口。

验收：以上全部是新文件/新增脚本入口，`git diff` 不触碰任何既有文件行为；`npm run coord:check` 通过。

## M3：调度按 spec 隔离 + 人工验收独立命令（已完成）

- `next-task.mjs`、`status.mjs` 加可选 `--spec` 参数：传入时只在该 spec 范围内判断 `awaiting-review` 门禁和候选任务；不传时行为与之前完全一致。
- 新增 `tools/ai-coord/accept-task.mjs`：人工专用的最终验收命令，写独立的 `human_acceptance` 字段，不复用 `review-task.mjs` 的字段。

验收：
- `node tools/ai-coord/next-task.mjs --spec <name> --agent <agent>` 只看到该 spec 任务。
- 不传 `--spec` 的调用结果与改造前逐字节一致。
- `accept-task.mjs` 写入的字段与 `review-task.mjs` 写入的字段互不覆盖。

## M4：能力解析 + 对抗评审池 + v2 契约全链路接入（已完成，经两轮 review 加固）

- `core.mjs` 加 capability 解析（读 `bindings.json`）、seat 独立性校验、v2 契约字段读取（`taskRequiredResources` 等）辅助函数。
- `spec-state.mjs`、`review-task.mjs` 支持多 seat 评审池 + `unanimous` 聚合，仅在 `bindings.json`/`contract_version` 存在时启用新路径；声明了池子就拒绝不带 `--seat` 的单一评审调用。
- `finish-task.mjs` 支持 `requires_human_acceptance` 标记；`accept-task.mjs` 只允许从 `awaiting-human-acceptance` 验收并校验底层评审确实 accepted。
- `next-task.mjs`/`status.mjs`/`renderPrompt` 全部改用 v2 感知的读取函数，v2 任务卡的资源锁需求、禁止事项、预期输出、验收标准在锁检查和 prompt 渲染里都正确可见。
- `product.md`/`collaboration.md` 身份措辞改写为能力措辞，附祖父条款；`tech.md` 补跨平台路径规则。

验收：
- 对既有 spec 任务卡跑一遍 `review-task.mjs`/`finish-task.mjs`，输出与改造前逐字节一致。
- 新建一个不带 `bindings.json` 的假 spec，确认其行为完全不受影响。
- 用真实锁申请/释放流程验证 v2 任务卡的 `resource_contract.requires` 确实被锁检查尊重。
- 两轮独立 review 发现的 7 个问题全部确认修复，见 `state.json` 的 `review_round_1`/`review_round_2`。

## M5：首次真实新 spec 采用（backlog）

- 挑一个真正的新 spec，完整用 `generic-loop.md` + `bindings.json` + 双 seat 评审池跑一遍 requirements→design→tasks→execution。

验收：两个独立窗口分别提交 verdict，`aggregate_verdict` 按 `unanimous` 正确聚合；`accept-task.mjs` 记录人工验收且不覆盖 `reviews[]`。

## M6：backlog

- 语义/向量检索（如果关键词检索证明不够用）。
- 任务体量自动拆分强制校验。

## 冻结范围

M5、M6 记录顺序供后续参考，不在已完成范围内。
