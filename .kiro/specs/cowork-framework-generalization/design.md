# 设计：cowork-framework-generalization

## 状态

`approved`（人工负责人已通过 plan 确认，含一次修正：评审对抗必须绑定不同 CLI 窗口/不同模型，而非同一会话的多次输出）。

## 已核实的现状问题（baseline 事实）

1. 角色硬编码不只在 loop 文件，根子在全局 steering：`product.md`/`collaboration.md` 直接写"Codex 是主要执行者"/"Claude 是评审、测试和反馈者"；`spec-state.mjs` 的 `ensureRequirements/ensureDesign/ensureTasks` 硬编码 `owner ??= "codex"; reviewer ??= "claude"`。某个业务 spec 角色对调时因此只能靠大段 prose 声明"不要套用现有 loop 文件"，并手改 `state.json` 成状态机自己都不认识的形状（`drafter`/`implementation_owner`/`accepted_by_codex`）。
2. `next-task.mjs`、`status.mjs` 都没有 `--spec` 参数：`awaiting-review` 门禁和候选任务筛选是跨全部 spec 的全局判断。多个 spec 的任务卡混在同一个目录下时，一个 spec 的评审会连带锁住其他 spec 的任务分配。
3. 某张历史任务卡里，AI 评审和人工最终验收共用同一批字段（`review_status`/`reviewed_by`/`review_artifact`），人工验收通过与 AI 评审相同的代码路径写入，覆盖了原本的 AI 评审记录。spec 级别的 `state.json` 反而做对了这件事（`accepted_by_claude`/`approved_by_human` 是独立字段），执行任务这一级没跟上。
4. loop 文件曾硬编码指向已经关闭的旧 spec；`README.md` 曾停留在早期、`design.md` 之前的世界。两者已作为独立 P0 修复处理，不依赖本设计其余部分。
5. 某个业务 loop 文件、某张历史任务卡里硬编码了 Windows 盘符路径，违反 `tech.md` 自己的跨平台规则。
6. 任务卡 `requires`/`forbidden` 混了"资源锁"与"角色/流程边界规则"；评审是单一 reviewer/单一 verdict，没有对抗聚合；仓库没有任何断言脚本，`coord:check` 只做语法检查。

## 不变量（保留不动）

- `requirements.md → design.md → tasks.md → execution` 门禁顺序；人工在每个阶段做最终裁决。
- 状态落文件不落聊天；`.ai-coord/{locks,events,artifacts}` 的既有语义。
- `tools/ai-coord/lib/core.mjs` 的锁/JSON/事件日志工具函数直接复用；`lock.mjs` 已完全通用，不改。
- `state.json` 保持自由形态，不上 JSON Schema 强校验——灵活表达阶段跳跃等特殊情况的能力，比强校验更重要。
- 既有 spec 的现有文件、既有工具在不传新参数时的行为，全部不动。

## 总体架构

全部新增/改造遵循"只加不拆、向后兼容"。

### 1. 能力角色层

`.kiro/roles/capabilities.json`（能力目录索引）+ 每个能力一份 prose 文件（`architect`/`implementer`/`reviewer`/`tester`）。新增能力只需追加条目和文件，不改代码。

`product.md`/`collaboration.md` 的身份表述改写为能力表述，附祖父条款：没有 `bindings.json` 的 spec 继续按现有 loop 文件的身份表述运行。

### 2. 每 spec 绑定 + 对抗式评审池必须是不同 CLI 窗口/不同模型

每 spec 一份 `bindings.json`：

```json
{
  "spec": "example-spec",
  "capabilities": { "architect": "codex", "implementer": "codex", "tester": "claude" },
  "review_pools": {
    "design":     { "seats": [ { "seat_id": "reviewer-a", "agent": "claude" }, { "seat_id": "reviewer-b", "agent": "codex" } ], "aggregation": "unanimous" },
    "tasks":      { "seats": [ "..." ], "aggregation": "unanimous" },
    "execution":  { "seats": [ "..." ], "aggregation": "unanimous" }
  }
}
```

硬性规则：

- 一个评审池至少 2 个 seat，且没有 seat 绑定的 agent 等于该产物的 `implementer`。
- seat 之间必须是独立 CLI 进程/窗口——不能同一会话身兼多个 seat。评审 seat 只能靠人工另开一个终端窗口，指定 `--spec <name> --capability reviewer --seat <seat_id>` 启动新会话来填。
- 优先绑定不同底层模型（`codex` vs `claude`）；只有没有第二个可用 vendor 时，才允许同一 vendor 开两个独立、互不知情的窗口顶替，且需在 seat 里如实标注模型多样性打了折扣。
- seat 在提交自己的 verdict 前不得读取其他 seat 的 verdict/artifact；全部 seat 提交后才计算 `aggregate_verdict`（默认策略 `unanimous`）。
- 人工始终看到全部 seat 的原始 verdict + artifact，不是被合并总结过的版本。
- 一旦某阶段声明了 `review_pools`，工具必须拒绝不带 `--seat` 的单一评审调用——声明了池子却还能被单一评审绕过，等于池子形同虚设（review round 1 finding）。

`.kiro/agents/generic-loop.md`：参数化（`--spec`、`--capability`、可选 `--seat`）的通用 loop 协议，取代逐 spec 手写文件，把 seat 独立性规则和"读 state → 判断阶段 → 调 spec-state.mjs"逻辑合并进去。

### 3. 任务契约拆分 + 人工验收与 AI 评审彻底分离

新任务卡加 `contract_version: 2`：`capability_required`、`resource_contract{requires,forbidden}`、`process_contract{forbidden_behaviors,requires_human_acceptance}`、`io_contract{required_inputs,allowed_writes,outputs}`、`acceptance_criteria[{id,description,check_type,check_ref}]`、`knowledge_refs`、`reviews[]`、`review_aggregation{policy,status}`、独立的 `human_acceptance{status,by,at,artifact,notes}`。

`human_acceptance` 用专门的新命令 `accept-task.mjs` 写入，不复用 `review-task.mjs`——直接堵死"人工验收覆盖 AI 评审记录"这类问题。legacy 卡（无 `contract_version`）原样读取，不回填。

**关键教训（review round 2 finding）**：光加 schema 和能力解析不够——锁检查（`findBlockingLocks`）、prompt 渲染（`renderPrompt`）、任务领取时写回的元数据（`next-task.mjs` 的 `required_resources`）、任务能否被按能力标签认领（`next-task.mjs` 的候选筛选）、任务卡的展示（`status.mjs`）都必须能正确读取 v2 嵌套字段，不能只兼容顶层扁平字段，否则 v2 契约声明的资源锁需求会被安全检查悄悄无视。`core.mjs` 提供一组 `taskRequiredResources()`/`taskForbiddenResources()`/`taskForbiddenBehaviors()`/`taskOutputs()`/`taskAllowedWrites()`/`taskRequiredInputs()`/`resolveTaskAssignee()` 读取函数作为唯一入口，所有消费任务卡字段的地方都必须通过它们读取（v2 优先，legacy 兜底），不能直接访问扁平字段。

### 4. 知识库（RAG 低成本第一版）

`knowledge/manifest.json` 登记文档（id/title/tags/source/path）。`knowledge-search.mjs --spec <name> --query <text>` 做纯关键词/全文检索，不引入 embedding 依赖。`source: "inline"` 全文索引；`source: "external"`（指向本仓库之外的路径）只按 title/tags 匹配，不假设文件在当前系统可读。知识库是只读输入，不能绕过评审门禁。语义检索留作后续可选项。

### 5. 客户需求 intake + 细粒度拆解

结构化 intake 模板（目标/约束/干系人/禁止事项/期限）在 `requirements.md` 起草前先过一遍（本 spec 自己的 `intake.md` 即示范）。任务 ID 沿用 `T-<spec>-<milestone>-<step>` 惯例，加一条评审可检查的拆分规则：`outputs` 超过一定数量或跨了不止一个资源锁域就要求拆分。

## 具体文件改动

```
新增：
  .kiro/roles/capabilities.json + {architect,implementer,reviewer,tester}.md
  .kiro/agents/generic-loop.md
  .ai-coord/schemas/{task-card,knowledge-manifest}.schema.json
  tools/ai-coord/knowledge-search.mjs
  tools/ai-coord/accept-task.mjs
  tools/ai-coord/self-test.mjs             轻量断言脚本（无新依赖），接入 coord:check

改（guard 式：有 bindings.json / contract_version 才走新逻辑）：
  .kiro/steering/product.md, collaboration.md   身份措辞 -> 能力措辞 + 祖父条款
  .kiro/steering/tech.md                        补"持久化路径不得含操作系统专属盘符"规则
  tools/ai-coord/lib/core.mjs                    加 capability 解析、seat 独立性校验、
                                                  v2 契约字段读取（taskRequiredResources 等）辅助函数
  tools/ai-coord/next-task.mjs, status.mjs       加可选 --spec 过滤；按能力解析 assignee；
                                                  锁检查/claim 元数据改用 v2 感知的读取函数
  tools/ai-coord/spec-state.mjs, review-task.mjs 支持多 seat 评审池 + 聚合；声明了池子就拒绝
                                                  不带 --seat 的单一评审路径
  tools/ai-coord/finish-task.mjs                 声明 requires_human_acceptance 时转 awaiting-human-acceptance
  tools/ai-coord/accept-task.mjs                 只允许从 awaiting-human-acceptance 验收，
                                                  并校验底层评审确实是 accepted
  package.json                                    加 coord:knowledge、coord:self-test、coord:accept

原则性不动：
  既有 spec 的现有文件——原样跑完，不回填新 schema/绑定/评审池机制
  lock.mjs                                         已完全通用，不改
```

## 任务队列原则

沿用现有 `next-task.mjs` 的"串行评审门禁、返工优先、资源锁阻塞"三条规则；`--spec` 过滤是在这三条规则之上加的作用域限定，不改变规则本身。

## Design 回应矩阵

| 需求 | 本设计如何回应 |
|---|---|
| 需求 1（能力角色独立于身份） | `.kiro/roles/*` + `bindings.json.capabilities` + steering 祖父条款 |
| 需求 2（评审必须多窗口对抗） | `bindings.json.review_pools` 的 seat 独立性硬性规则 + `generic-loop.md` 协议 + 声明池子后拒绝单一评审路径 |
| 需求 3（契约拆分 + 验收分离 + 全链路 v2 感知） | `contract_version: 2` 任务卡 schema + `accept-task.mjs` + `core.mjs` 的 v2 感知读取函数接入锁检查/prompt/claim 元数据/dashboard |
| 需求 4（调度按 spec 隔离） | `next-task.mjs`/`status.mjs` 可选 `--spec` |
| 需求 5（知识库） | `knowledge/manifest.json` + `knowledge-search.mjs` |
| 需求 6（既有 spec 不受影响） | 全部改动 guard 在新标记存在时才生效；每阶段验证既有 spec 输出逐字节一致 |

## 阻塞条件

- 若对共享脚本（`core.mjs`/`spec-state.mjs`/`review-task.mjs`/`finish-task.mjs`）的改动无法验证对既有 spec 现有调用保持无操作(no-op)兼容，该阶段必须停止并回退，不得强行合并。
- 若发现某个"纯增量"文件与既有文件命名冲突，停止并请人工负责人裁决命名。
