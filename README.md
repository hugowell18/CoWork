# Cowork AI 协作工程（通用模板）

这是一个用来实践 **规格驱动、循环式多 Agent 协作** 的本地工程模板。`main` 分支不含任何具体业务代码，是给新项目起步用的干净基座；具体项目的 spec、工具脚本应该在从 `main` 拉出的项目分支里补充。

核心流程：

```text
长期规则 -> 需求确认 -> Codex 产出 -> Claude 评审 -> Codex 返工 -> Claude 接受 -> 人工负责人最终裁决
```

评审可以是单一 reviewer（默认，向后兼容），也可以是多个独立 CLI 窗口/模型组成的对抗评审池（spec 通过 `bindings.json` 声明）。

## 新项目怎么起步

1. 从 `main` 拉一个新分支作为项目分支。
2. 在 `.kiro/specs/<你的项目名>/` 下起草 `intake.md`（结构化需求 brief）和 `requirements.md`。
3. 人工负责人确认 requirements 后，走 `requirements → design → tasks → execution` 门禁（见"规格门禁"）。
4. 需要多个能力承担者按角色对调、或需要对抗评审池时，在 `.kiro/specs/<你的项目名>/bindings.json` 里声明（示例见 `.kiro/specs/cowork-framework-generalization/design.md` 的"每 spec 绑定"一节）。
5. 项目特有的工具脚本放在项目自己的目录下（例如 `tools/<项目名>/`），不要和 `tools/ai-coord/` 混在一起——后者是所有项目共用的协调机制本体。
6. 需要检索项目参考资料时，用 `.kiro/specs/<你的项目名>/knowledge/manifest.json` 登记文档，通过 `npm run coord:knowledge -- --spec <你的项目名> --query "<关键词>"` 检索。

## 当前结构

```text
.kiro/
  steering/                         长期规则（跨项目通用，不含具体业务）
    product.md                      产品与目标规则
    collaboration.md                Codex、Claude、人工负责人协作规则（含能力/对抗评审池规则）
    tech.md                         循环式运行时技术规则、跨平台规则
    structure.md                    目录结构规则
  roles/                            能力目录：architect / implementer / reviewer / tester
  agents/
    generic-loop.md                 通用 loop 启动说明：--spec --capability [--seat]
  specs/
    cowork-framework-generalization/  本框架自身的设计记录（见下）
    <你的项目名>/
      intake.md                     结构化需求 brief（可选但推荐）
      requirements.md               需求
      design.md                     设计（需求确认后才创建）
      tasks.md                      任务拆解（设计批准后才创建）
      state.json                    当前阶段与人工确认状态
      bindings.json                 能力绑定 + 对抗评审池声明（可选）
      knowledge/                    项目参考资料（可选）

.ai-coord/
  locks/                            本地资源锁，具体资源由 spec/task 定义
  events/                           事实事件（按天分文件的 JSONL）
  artifacts/                        评审、验证等输出物（已 gitignore，不进版本库）
  schemas/                          task-card / knowledge-manifest 的 JSON Schema
  tasks/                            execution 阶段的任务卡（项目分支自己产生）
  inbox/                            渲染给各 agent 的任务提示

tools/ai-coord/                     协作机制 CLI（状态机、任务队列、锁、评审、知识库检索）——所有项目共用，不要改动来适配单个项目
```

## `cowork-framework-generalization` 是什么

这是框架自己的设计记录：记录了能力角色层、对抗评审池、v2 任务契约、知识库这几个机制是怎么设计出来的，以及两轮独立 review 发现并修复的 7 个问题（评审池可被绕过、人工验收可以抢跑评审、v2 契约在执行路径被忽略等）。不是业务 spec，不需要参照它的门禁流程，但改动 `tools/ai-coord/` 或 `.kiro/roles/` 之前建议先读一遍，了解现有设计的取舍和已经踩过的坑。

## 一次性 Loop 启动

不需要每轮复制长提示。各自只需要一次启动：

```text
读取 .kiro/agents/generic-loop.md，并按 --spec <name> --capability <architect|implementer|reviewer|tester> [--seat <seat_id>] 开始循环。
```

之后状态由 spec 自己的 `.kiro/specs/<spec-name>/state.json` 驱动。

## 角色分工

- 能力（architect / implementer / reviewer / tester）由每个 spec 的 `bindings.json` 绑定到具体 agent；没有 `bindings.json` 的 spec 默认按 Codex=主要执行者、Claude=评审与测试反馈者运行。
- 人工负责人：负责人和最终裁决者。确认需求，在 Claude/评审池接受设计、任务拆解或实现后做最终裁决，批准高风险动作。

## 规格门禁

1. Codex（或绑定的 architect 能力）起草 `requirements.md`。
2. 人工负责人审阅并确认，或要求修改。
3. 起草 `design.md`。
4. Claude（或绑定的 reviewer 能力/评审池）评审 `design.md`。
5. 按反馈返工，直到评审接受或阻塞。
6. 评审接受后，人工负责人最终批准或驳回 design。
7. Design 通过后，起草 `tasks.md`，重复评审 -> 返工 -> 接受 -> 人工负责人最终批准。
8. 只有在 `tasks.md` 最终批准后，才进入执行队列或创建执行任务。

## 协调命令

查看状态（可选 `--spec` 限定某个项目）：

```shell
npm run coord:status -- --spec <spec-name>
```

领取/查看下一个任务：

```shell
node tools/ai-coord/next-task.mjs --agent <agent> --spec <spec-name>
```

评审（legacy 单一评审，或对抗评审池的某个 seat）：

```shell
node tools/ai-coord/review-task.mjs --agent <agent> --task <task-id> --verdict <accepted|changes-requested|blocked> --artifact <path> [--seat <seat_id>]
```

人工最终验收（只有人工负责人用，不覆盖 AI 评审记录）：

```shell
node tools/ai-coord/accept-task.mjs --agent <human-identity> --task <task-id> --decision <accepted|rejected> --artifact <path>
```

申请/释放资源锁：

```shell
node tools/ai-coord/lock.mjs claim --agent <agent> --resource "resource-name" --ttl-minutes 120 --reason "说明原因"
node tools/ai-coord/lock.mjs release --agent <agent> --resource "resource-name"
```

知识库检索：

```shell
node tools/ai-coord/knowledge-search.mjs --spec <spec-name> --query "<关键词>"
```

语法检查 + 断言测试：

```shell
npm run coord:check
```
