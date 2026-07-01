# Cowork AI 协作工程

这是一个用来实践 **规格驱动、循环式多 Agent 协作** 的本地工程。

核心流程：

```text
长期规则 -> 需求确认 -> Codex 产出 -> Claude 评审 -> Codex 返工 -> Claude 接受 -> 人工负责人最终裁决
```

当前已经完成第一份 `requirements` 确认，进入 `design` 阶段。下一步由 Codex 起草 `design.md`，然后交给 Claude 评审；Claude 接受后再交给人工负责人最终裁决。

## 当前结构

```text
.kiro/
  steering/                         长期规则
    product.md                      产品与目标规则
    collaboration.md                Codex、Claude、人工负责人协作规则
    tech.md                         循环式运行时技术规则
    structure.md                    目录结构规则
  specs/
    data-weight-control/
      requirements.md               已确认的需求
      state.json                    当前处于 design 草案阶段

.ai-coord/
  locks/                            本地资源锁，具体资源由 spec/task 定义
  events/                           事实事件
  artifacts/                        输出物

tools/ai-coord/                     当前 bootstrap 脚本
```

## 一次性 Loop 启动

两个 CLI 不需要每轮复制长提示。各自只需要一次启动：

Codex CLI：

```text
读取 .kiro/agents/codex-loop.md，并按其中规则开始循环。
```

Claude CLI：

```text
读取 .kiro/agents/claude-loop.md，并按其中规则开始循环。
```

之后状态由 `.kiro/specs/data-weight-control/state.json` 驱动。

## 角色分工

- Codex：主要执行者。负责展开规格、实现任务、写实现说明。
- Claude：评审与测试反馈者。负责拉数据、跑 DB 重验证、写评审反馈。
- 人工负责人：负责人和最终裁决者。负责确认需求，并在 Claude 接受设计、任务拆解或实现后做最终裁决。

## 规格门禁

1. Codex 起草 `requirements.md`。
2. 人工负责人审阅并确认，或要求修改。
3. Codex 起草 `design.md`。
4. Claude 自动评审 `design.md`。
5. Codex 按 Claude 反馈返工，直到 Claude 接受或阻塞。
6. Claude 接受后，人工负责人最终批准或驳回 design。
7. Design 通过后，Codex 起草 `tasks.md`，并重复 Claude 评审 -> Codex 返工 -> Claude 接受 -> 人工负责人最终批准。
8. 只有在 `tasks.md` 最终批准后，才进入执行队列或创建执行任务。

## 协调命令

当前脚本是 bootstrap 工具，不是最终形态。队列、运行记录、CLI 适配器等运行时细节要等 `design.md` 阶段确认后再定义。

查看状态：

```shell
npm run coord:status
```

旧版调试命令，只有后续设计确认需要任务卡时才使用：

```shell
node tools/ai-coord/next-task.mjs --agent codex
node tools/ai-coord/next-task.mjs --agent claude
```

申请资源锁示例：

```shell
node tools/ai-coord/lock.mjs claim --agent claude --resource "resource-name" --ttl-minutes 120 --reason "说明原因"
```

释放资源锁示例：

```shell
node tools/ai-coord/lock.mjs release --agent claude --resource "resource-name"
```

语法检查：

```shell
npm run coord:check
```
