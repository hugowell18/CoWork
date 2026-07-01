# 结构规则

## 根目录结构

```text
<workspace-root>/Cowork
  .kiro/
    steering/
    specs/
  .ai-coord/
    locks/
    events/
    artifacts/
  tools/
    ai-coord/
```

## Steering 文件

长期共通规则放在：

```text
.kiro/steering/
```

当前 steering 文件：

- `product.md`
- `collaboration.md`
- `tech.md`
- `structure.md`

Steering 只能描述跨 spec 复用的规则。具体业务需求、领域约束、资源名称、实现方案和运行时目录应放到对应 spec 中。

## Spec 文件

每个 spec 至少使用：

```text
.kiro/specs/<spec-name>/requirements.md
.kiro/specs/<spec-name>/state.json
```

后续文件按门禁创建：

```text
.kiro/specs/<spec-name>/design.md
.kiro/specs/<spec-name>/tasks.md
```

只有人工负责人确认前一个阶段后，才能创建或推进下一个阶段。

## 最小协作状态文件

当前阶段 `.ai-coord/` 只保留：

- `locks/`：资源锁。
- `events/`：事实事件。
- `artifacts/`：输出物。

其他目录必须由具体 spec 的设计阶段提出，并在设计确认后创建。

## 命名规则

- Spec 名称使用 kebab-case。
- 任务 id 使用 `T-<spec-name>-<short-action>`。
- 资源名称由具体 spec 或 task 定义，使用稳定、可读的小写名称。
