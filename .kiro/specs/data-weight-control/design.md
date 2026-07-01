# 设计：数据重量控制

## 状态

`draft-for-claude-review`

本设计对应已批准的 `data-weight-control` 需求。当前只定义设计，不创建 `tasks.md`，不创建 `.ai-coord/tasks`，不执行 DuckDB 或数据文件读写操作。

## 设计目标

本 spec 的目标是把市场数据治理从“DuckDB 全量囤积”转向“Parquet 持久化、DuckDB 查询和热层、清单复现”的分层模式，并保持迁移过程可验证、可回滚、可跨平台运行。

核心原则：

- 原始层只追加，纠错通过新批次或显式修正表达。
- 清洗标准层以数据集契约驱动键、去重、幂等写入和质量门。
- 清洗标准数据优先写入按月分区的 Parquet，由 DuckDB 外部读取或视图查询。
- 外部化迁移必须先证明迁移前后查询结果一致。
- DuckDB 只作为查询引擎、元数据存储和按数据集声明的热层，不作为所有历史大表的默认长期仓库。
- 回测输入通过可测量清单复现，不把每次输入全量复制进 DuckDB。
- 所有持久化路径、artifact、状态和命令入口必须同时适配 Windows 和 macOS。

## 非目标

- 不在 P1 做外部化迁移、drop、归档、生产查询入口切换或历史数据改写。
- 不在设计阶段定义具体任务队列或执行任务卡。
- 不绕过 Claude 评审或人工负责人最终裁决。
- 不用协作型文件锁冒充数据库级强制锁。
- 不要求所有数据集使用同一个热窗口、同一个主键或同一个分区策略。

## 分期

### P1：零风险预检与增量同步可观测性

目标是先暴露现状，不迁移、不 drop、不改写历史数据。

P1 交付的能力是预检报告和增量同步可观测性报告：

- 读取数据集契约、协作锁状态、平台信息和可用工具版本。
- DuckDB 可用时，以只读方式统计表行数、日期覆盖、候选日期列、疑似增长速度和大表风险。
- DuckDB 被锁定、不可用或被打开句柄阻塞时，报告明确状态，不把失败包装成空结果。
- 检查每日同步是否具备增量边界，例如目标交易日、缺口日期、最近成功 ingest、最近质量报告和热数据集市刷新范围。
- 识别重复键、缺口日期、旧数据残留和覆盖异常的可疑信号。
- 把 `bar_minute`、`moneyflow_daily`、`daily_basic` 标记为第一批治理候选。
- 显示每个数据集声明的热窗口和策略风险，不显示全局热窗口。
- 写出 artifact，不切换查询入口，不改写任何数据表。

P1 artifact：

```text
.ai-coord/artifacts/data-weight-control/preflight/<run-id>.json
.ai-coord/artifacts/data-weight-control/preflight/<run-id>.md
```

P1 报告必须包含：

- 运行平台：`process.platform`、Node.js 版本、DuckDB 版本、项目根路径解析结果。
- 路径检查：所有持久化路径的项目相对路径和运行时绝对路径。
- 锁检查：相关资源锁持有者、过期时间、是否过期、是否阻断本次只读预检。
- DuckDB 状态：可用、被锁、不可用、打开失败或只读连接失败。
- 表级统计：表名、行数、识别出的日期列、日期范围、最近日期、疑似分区键。
- 数据集级统计：契约热窗口、迁移候选、策略风险、长回看要求、缺口提示、重复键提示。
- 增量同步观察：最近 ingest run、应同步日期、疑似全历史刷新风险、热数据集市刷新范围。
- 结论：`pass`、`warn` 或 `blocked`，以及阻断原因。

### P2：Raw/Clean 分层与 Parquet 落地

目标是建立原始层、清洗标准层、按月分区 Parquet、质量门和一致性验证。

P2 可以引入数据写入流程，但每个迁移动作必须先经过任务拆解、Claude 评审和人工负责人批准。设计约束如下：

- 外部源数据先写入 raw 层，raw 层只追加。
- raw 层每条记录或旁路元数据必须能关联 `source`、`dataset`、`trade_date`、`ingest_run_id`、`fetch_time` 和 `usable_scope`。
- clean 层由数据集契约定义逻辑键、日期列、去重策略、分区粒度、排序列和热层用途。
- 标准日频表默认逻辑键为 `(ts_code, trade_date)`；不适用的数据集必须显式声明替代键。
- clean 写入必须幂等：同一输入批次重复执行，最终有效结果不变。
- clean 写入遇到重复键时，只允许两种结果：按契约自动去重并报告，或阻断并报告；禁止静默通过。
- Parquet 分区默认按月，目标是每个数据集每月一个或少量文件。
- DuckDB 通过外部读取或视图查询 clean Parquet，不把全历史默认导入主 DB 文件。
- 所有外部化迁移必须完成一致性验证；失败时禁止切换默认入口，禁止 drop 原表。
- drop 或归档原表必须有恢复步骤和人工负责人单独批准。

P2 artifact：

```text
.ai-coord/artifacts/data-weight-control/quality/<run-id>.json
.ai-coord/artifacts/data-weight-control/quality/<run-id>.md
.ai-coord/artifacts/data-weight-control/migration-verify/<run-id>.json
.ai-coord/artifacts/data-weight-control/migration-verify/<run-id>.md
.ai-coord/artifacts/data-weight-control/rollback/<run-id>.md
```

### P3：热层治理与回测复现

目标是在 P1/P2 的质量和迁移机制稳定后，收紧 DuckDB 热层用途，并通过清单保证回测复现。

P3 交付的能力：

- 按数据集声明热、温、冷边界，而不是设置全局热窗口。
- `bar_daily` 默认保持全历史可用，不被全局窗口截断。
- `bar_minute` 作为 Parquet 优先和热窗口治理第一候选。
- `daily_basic` 可作为 DuckDB 外部 Parquet 视图候选。
- `moneyflow_daily` 迁移前必须证明分区、排序或裁剪策略不会让常见 symbol 跨历史查询退化为高风险全表扫描。
- 回测清单记录数据快照引用、策略版本、代码身份、生成时间、输入数据集、分区路径、行数、最大日期、校验和或采集批次集合。
- 已接受的数据缺口或质量例外必须进入回测清单或相邻质量报告。

P3 artifact：

```text
.ai-coord/artifacts/data-weight-control/hot-layer/<run-id>.json
.ai-coord/artifacts/data-weight-control/hot-layer/<run-id>.md
.ai-coord/artifacts/data-weight-control/backtest-manifest/<manifest-id>.json
.ai-coord/artifacts/data-weight-control/backtest-manifest/<manifest-id>.md
```

## 数据集契约

每个受治理数据集必须有契约。契约是 P1 预检、P2 写入和 P3 热层治理的共同输入。

契约字段：

```json
{
  "dataset": "bar_daily",
  "category": "market-bar",
  "logical_key": ["ts_code", "trade_date"],
  "date_column": "trade_date",
  "partition": {
    "type": "month",
    "column": "trade_date",
    "format": "YYYY-MM"
  },
  "sort_order": ["ts_code", "trade_date"],
  "dedup": {
    "mode": "last-write-wins",
    "order_by": ["fetch_time", "ingest_run_id"],
    "on_unresolved_tie": "block"
  },
  "usable_scope": {
    "allowed_values": ["provisional", "validated", "corrected", "rejected"],
    "default": "provisional"
  },
  "hot_layer": {
    "mode": "all-history",
    "reason": "long lookback daily strategies"
  },
  "storage": {
    "raw_path": "data/raw/bar_daily",
    "clean_path": "data/clean/bar_daily"
  },
  "small_file": {
    "max_files_per_month": 4,
    "min_average_file_mb": 32
  },
  "strategy_risks": ["long-lookback", "rolling-window"],
  "migration": {
    "candidate": false,
    "requires_human_approval_to_drop": true
  }
}
```

规则：

- `dataset` 使用稳定的小写名称，不允许仅靠大小写区分。
- `logical_key` 不能为空；日频默认 `(ts_code, trade_date)`。
- `date_column` 必须能映射到分区字段；无法映射时必须声明原因。
- `dedup.order_by` 必须形成确定性顺序；如果并列无法确定，必须阻断。
- `usable_scope` 表示 raw 批次是否可进入 clean 和策略输入，最小取值为 `provisional`、`validated`、`corrected`、`rejected`；只有契约允许的 scope 才能进入 clean 有效分区。
- `hot_layer.mode` 可为 `all-history`、`rolling-window`、`external-only` 或 `metadata-only`。
- `storage.*_path` 必须是项目根目录相对路径，使用 `/` 作为持久化分隔符。
- 小文件阈值可按数据集覆盖；未覆盖时使用默认阈值。
- 任意表只要实际行数、日期跨度、增长速度或使用方式超出契约声明的 `hot_layer` 用途，就必须被 P1 预检自动标记为迁移候选；预置候选名单只是第一批默认规则，不是唯一来源。

第一批数据集默认决策：

| 数据集 | 初始定位 | 设计处理 |
| --- | --- | --- |
| `bar_daily` | 体量较小但长回看 | clean Parquet 可全历史；DuckDB 可建外部视图；不得被全局热窗口截断 |
| `bar_minute` | 高增长分钟线 | Parquet 优先候选；热层只能按契约声明近期窗口 |
| `daily_basic` | 治理候选 | 可考虑 DuckDB 外部 Parquet 视图；迁移前需一致性验证 |
| `moneyflow_daily` | 治理候选且 symbol 跨历史风险高 | 必须证明分区、排序或裁剪策略能支撑常见查询 |

## 存储布局

所有持久化路径写入状态、契约、manifest 和 artifact 时都使用项目根目录相对路径和 `/` 分隔符。运行时再解析为当前操作系统路径。

建议布局：

```text
data/
  raw/
    <dataset>/
      source=<source>/
        ingest_date=YYYY-MM-DD/
          ingest_run_id=<run-id>/
            part-000.parquet
            metadata.json
  clean/
    <dataset>/
      trade_month=YYYY-MM/
        _current.json
      _versions/
        <partition-id>/
          <version-id>/
            part-000.parquet
            _quality.json
            manifest.json
  marts/
    <dataset>/
      window=<contract-defined-hot-window>/
        part-000.parquet
metadata/
  dataset-contracts/
    <dataset>.json
  manifests/
    backtest/
      <manifest-id>.json
```

布局规则：

- raw 层只追加。已有 `ingest_run_id` 目录不得静默覆盖。
- clean 层按月分区。分区目录使用 `trade_month=YYYY-MM`；如数据集不用交易日期，契约必须声明替代分区列和目录名。
- clean 分区写入采用版本化 staging：先写入 `_versions/<partition-id>/<version-id>/`，质量门通过后再用 `_current.json` 指向当前有效版本。
- `_current.json` 是普通 JSON pointer/manifest 文件，不使用符号链接、不使用 case-only rename、不原地替换 Parquet 目录。发布新版本时只原子替换同目录下的 `_current.json`。
- 替换 clean 分区前必须保留上一版本，直到质量报告和必要回滚窗口结束。
- `marts/` 只保存按契约声明的热数据集市，不保存所有历史副本。热窗口目录命名为小写 `window=<mode>` 或 `window=<mode>-<value>`，例如 `window=all-history`、`window=rolling-90d`、`window=external-only`，不得依赖大小写差异。
- artifact 使用 `.ai-coord/artifacts/data-weight-control/`，不混入业务数据目录。

## 每日增量同步流程

每日同步默认只处理当天或缺口日期，不做全历史刷新。同步流水线必须按以下顺序执行，任何一步失败都不得静默进入下一步：

1. raw append：从外部源拉取目标日期或缺口日期，写入 raw 层新 `ingest_run_id`。
2. clean partition：只重建受影响的 clean 月分区 staging 版本，并保留当前有效版本。
3. quality gate：执行键、重复、缺口、旧数据残留、行数和日期范围检查，写出质量 artifact。
4. mart refresh：只有质量门通过后，才刷新契约声明的热数据集市或外部视图引用。

全历史重建是单独任务类型，必须由人工负责人明确批准后才能触发。全历史重建任务必须声明目标数据集、日期范围、资源锁、回滚方式和验收 artifact；默认每日同步路径不得把缺口修复扩大成全历史刷新。

如果同步发现重复键、缺口日期、质量门失败、旧数据残留、锁冲突或打开句柄冲突，处理结果只能是按契约显式处理并报告，或进入 `blocked`；不得继续刷新 mart 或切换查询入口。

## Raw 层设计

raw 写入流程：

`usable_scope` 是 raw metadata 的必填字段，用于表达该批次是否可进入后续 clean 和策略输入。最小结构为 `status`、`valid_from`、`valid_to`、`reason` 和 `allowed_consumers`；`status` 只能取 `provisional`、`validated`、`corrected`、`rejected`。`rejected` 批次不得进入 clean 有效分区，`provisional` 批次是否可用必须由数据集契约声明。

1. 为每次外部采集生成全局唯一 `ingest_run_id`。
2. 记录 `source`、`dataset`、`fetch_time`、请求参数、交易日期范围和 `usable_scope`。
3. 写入 raw Parquet 或等价原始文件，并写入同目录 `metadata.json`。
4. 如果采集结果是对旧数据的纠正，写入新的 `ingest_run_id`，并在 metadata 中记录 `correction_of` 或 `supersedes`，不覆盖旧文件。
5. raw 写入完成后生成 ingest artifact，供 clean 层引用。

raw 不直接作为策略或回测默认输入。策略默认读取 clean 层、热数据集市或回测清单指定的快照。

## Clean 层设计

clean 写入输入包括 raw 批次、数据集契约和目标月份。

clean 有效分区必须随附可追溯元数据，不能只依赖 Parquet 文件本身。每个 `_versions/<partition-id>/<version-id>/manifest.json` 和发布后的 `_current.json` 至少保留以下字段：

- `dataset`、`partition_id`、`version_id`、`created_at`、`status`。
- `logical_key`、`date_column`、`date_range`、`row_count`、`checksum`。
- `source_ingest_runs`：贡献本分区的 `source`、`ingest_run_id`、`fetch_time`、`usable_scope`、raw metadata 路径。
- `ingest_run_ids`：供回测 manifest 直接复用的采集批次集合。
- `quality_artifact`、`duplicate_key_count`、`dedup_strategy`、`previous_version_id`。

`_current.json` 只保存当前有效版本指针和上述最小追溯摘要；完整质量细节保存在版本目录的 `_quality.json` 和 artifact 中。回测 manifest 的 `ingest_run_ids` 必须来自 clean 分区 manifest，不能由回测流程重新猜测。

幂等写入流程：

1. 从契约读取 `logical_key`、`date_column`、分区规则和去重规则。
2. 读取目标月份已有有效 clean 版本和本次 raw 批次。
3. 标准化字段类型、日期格式和空值表示。
4. 按 `logical_key` 分组检测重复键。
5. 根据契约执行确定性去重，或在契约要求阻断时停止。
6. 对去重结果执行质量门。
7. 将新有效分区写入 staging 版本目录。
8. 质量门通过后更新当前分区；失败时保留失败 artifact，不改变当前有效分区。

默认去重策略：

- 标准日频数据默认 `last-write-wins`。
- 排序优先级默认 `fetch_time`、`ingest_run_id`。
- 如果数据源有明确优先级，契约可声明 `source_priority`，并把它放在 `order_by` 前部。
- 如果排序后仍出现无法确定的并列 winner，质量门必须阻断。

质量报告必须包含：

- 输入 raw 批次数、输入行数、目标分区。
- 去重前行数、去重后有效行数。
- 重复键数量、重复行数量、重复键样例。
- 去重策略、winner 选择字段、无法决策的 tie 样例。
- 日期范围、空值分布、关键数值列摘要。
- 质量门结论和是否更新有效分区。

## 分区和文件大小

默认分区粒度：

- 日频及低频标准数据：按月分区。
- 分钟线等高增长数据：仍优先按月作为一级分区；如单月文件过大，可由契约增加二级 bucket，但不得退化为 `trade_date × symbol` 小文件布局。
- tick 或极高频数据不在本设计第一批落地范围内；如果纳入，必须新增契约和单独设计。

文件目标：

- 每个数据集每月默认 1 个 Parquet 文件。
- 若单月数据较大，可写少量文件，但默认不超过 `small_file.max_files_per_month`。
- 若某月文件数量超过阈值，或平均文件大小低于 `small_file.min_average_file_mb`，预检报告标记压实候选。
- 压实必须作为显式任务执行，不能在查询路径中静默发生。

查询优化：

- clean Parquet 写入时按契约 `sort_order` 排序。
- 对常见 symbol 跨历史查询的数据集，必须在契约中声明排序、bucket 或辅助索引方案。
- `moneyflow_daily` 迁移前必须用代表性 symbol 跨历史查询证明裁剪方案可接受。

## DuckDB 使用边界

DuckDB 允许用途：

- `instrument`
- `trade_calendar`
- `board_metadata`
- `ingest_metadata`
- `quality_check_metadata`
- 近期热数据集市
- `result_index`
- `signal_book`
- `candidate_book`
- clean Parquet 的外部视图或查询入口

DuckDB 禁止默认承担的用途：

- 全量分钟线长期存储。
- tick 数据长期存储。
- 所有历史大宽表长期存储。
- 所有中间研究产物长期存储。
- 未经契约声明的全局热窗口截断。

DuckDB 查询入口：

- P1 只读预检可以读取 DuckDB 元数据和表统计。
- P2/P3 中可为 clean Parquet 创建外部视图，但创建或切换默认入口需要任务批准。
- 任何生产默认查询入口切换都必须依赖一致性验证 artifact 和人工负责人批准。

## 外部化迁移一致性验证

任何 in-DB 表外部化为 Parquet 或外部视图前，都必须执行迁移验证。

验证输入：

- 源 DuckDB 表或视图。
- 目标 Parquet 分区或目标外部视图。
- 数据集契约。
- 验证窗口定义。

验证窗口至少包括：

- 最新完整月份。
- 最早月份或边界月份。
- 体量最大的月份。
- 策略关键窗口。
- 随机抽样 symbol 或日期窗口。
- 可行时的全量主键集合校验。

验证项：

- 行数。
- 主键集合。
- 日期范围。
- 关键数值列聚合和排序无关校验和。
- 空值分布。
- 重复键数量。
- 按逻辑键排序后的逐行一致性样例。
- 失败样例，包括源值、目标值和主键。

校验和规则：

- 默认验证模式是在同一个 DuckDB 连接中同时查询源 in-DB 表和目标 Parquet 视图，用同一组 SQL 规范化表达式计算行数、主键集合、聚合和校验和，避免不同引擎哈希实现不可比。
- 如必须跨 DuckDB 与 Node 或其他读取器计算校验和，必须使用引擎无关的规范化序列化：按契约字段顺序输出类型标记、规范化值和空值哨兵，按逻辑键排序生成行哈希，再对有序行哈希序列计算 SHA-256。
- 禁止把 DuckDB 内置 hash 与 Node、Python 或 Parquet reader 的本地 hash 直接比较；跨引擎实现必须先通过固定 fixture 证明等价。

- 校验和必须排序无关。
- 数值列必须先按契约声明的精度和空值规则规范化。
- 文本列必须说明大小写、空白和编码规范。
- 日期和时间必须规范化为契约时区或日期格式。

验证结果：

- `passed`：允许提交给 Claude 评审和人工负责人批准下一步切换或归档。
- `failed`：禁止切换查询入口，禁止 drop 或归档源表。
- `blocked`：工具不可用、锁冲突、打开句柄冲突或验证输入不完整；交给人工负责人裁决。

验证 artifact 必须包含验证 SQL、窗口范围、行数、校验和、失败样例和结论。

## 回滚设计

外部化、归档和 drop 都是高风险动作。

回滚要求：

- 迁移前保留源表或可恢复备份，直到一致性验证通过且人工负责人批准。
- clean Parquet 分区必须能重建被 drop 的表或等价视图。
- drop 原表前必须写出 rollback artifact。
- 不可逆或难以回滚的动作必须单独列为人工负责人确认项。
- 迁移失败时默认回到迁移前查询路径，不允许半切换状态继续服务策略。

rollback artifact 必须包含：

- 源表名称、schema、行数、日期范围。
- 源表位置或备份位置。
- 目标 Parquet 分区路径。
- 目标视图定义。
- 一致性验证 artifact 路径。
- 恢复命令或恢复步骤。
- 切回旧查询入口的步骤。
- 人工批准记录引用。

## 回测清单

正式回测必须写入 manifest，而不是复制所有输入表到 DuckDB。

manifest 字段：

```json
{
  "manifest_id": "bt-20260630-001",
  "created_at": "2026-06-30T00:00:00Z",
  "strategy": {
    "name": "example-strategy",
    "version": "v1",
    "code_identity": "commit-or-equivalent-id"
  },
  "inputs": [
    {
      "dataset": "bar_daily",
      "snapshot_ref": "data/clean/bar_daily/trade_month=2026-06",
      "partitions": ["data/clean/bar_daily/trade_month=2026-06/part-000.parquet"],
      "row_count": 123456,
      "max_date": "2026-06-30",
      "checksum": "sha256-or-sort-independent-checksum",
      "ingest_run_ids": ["run-..."],
      "quality_artifact": ".ai-coord/artifacts/data-weight-control/quality/run-....json"
    }
  ],
  "accepted_quality_exceptions": []
}
```

规则：

- `snapshot_ref` 和 `partitions` 必须是项目相对路径。
- 每个输入数据集至少记录分区路径、行数、最大日期、校验和或采集批次集合。
- 质量例外必须显式记录，不能只存在聊天记录里。
- manifest 必须能定位到当时的数据字节，或定位到等价可重建的分区版本。

## 跨平台设计

路径规则：

- 持久化路径统一使用项目根目录相对路径和 `/`。
- 禁止在契约、manifest、artifact 中把 Windows 盘符或 macOS 用户目录作为唯一引用。
- 运行时解析路径时，先拒绝绝对路径、空路径、包含 `..` 越界的路径，再转换为当前平台路径。
- 数据集名、表名、分区目录和 artifact 名称统一小写，禁止仅靠大小写区分。

文本和 JSON：

- 写入 UTF-8，不写 BOM。
- 读取器必须容忍 UTF-8 BOM。
- 读取器必须容忍 LF 和 CRLF。
- JSON 写入采用临时文件加原子替换；失败时保留原文件。
- `_current.json` 发布采用同目录临时文件，例如 `_current.<pid>.tmp`，写入并 flush 后原子 rename 为 `_current.json`；rename 失败时保留旧 `_current.json` 并报告 `blocked`。

文件写入：

- Parquet 写入先写 staging 目录，质量门通过后再发布。
- 读取 clean 分区时先读取 `_current.json`，再解析其指向的版本目录；禁止用符号链接、快捷方式、case-only rename 或被 UI 句柄占用时的目录替换来表达当前版本。
- 临时文件和目标文件必须在同一文件系统内，避免跨设备 rename。
- Windows 上如果目标被打开句柄占用，rename 或 delete 可能失败；此时必须报告 `blocked`，不得重试到破坏一致性。
- macOS 上默认文件系统可能大小写不敏感；禁止 case-only rename 和 case-only 资源名差异。
- 删除、归档和 drop 都不能作为静默清理动作执行，必须由任务和批准记录驱动。

命令入口：

- 核心脚本使用 Node.js 入口。
- 文档示例避免依赖 PowerShell、cmd、bash 或 zsh 的专属语法。
- 如果必须调用平台工具，必须提供 Windows 和 macOS 等价说明。

## 协作锁和资源归属

锁是协作型文件锁，不是数据库级强制锁。

资源命名建议：

| 资源 | 用途 |
| --- | --- |
| `duckdb` | DuckDB 读写、迁移验证、视图切换 |
| `data-raw/<dataset>` | raw 层指定数据集写入 |
| `data-clean/<dataset>` | clean 层指定数据集写入、压实、分区发布 |
| `data-migration/<dataset>` | 外部化迁移、一致性验证和回滚 |
| `backtest-manifest/<manifest-id>` | 回测清单生成 |

规则：

- Codex 在当前 design 阶段不碰 DuckDB。
- Claude 做 DB 重验证前必须持有或检查 `duckdb` 锁。
- 任务需要资源时必须在任务声明 `requires`；禁止资源必须声明 `forbidden`。
- 过期锁可以被报告，但不能被静默忽略。
- 写窗口内必须要求相关 UI 暂停、切换只读连接，或通过串行化写入口执行。
- 如果发现不守规矩的进程或 UI 句柄阻塞写入，状态应为 `blocked`，由人工负责人裁决。
- Claude 评审输出问题发现和测试反馈，不静默修改 Codex 负责的实现。

## 质量门

P1 质量门：

- 预检 artifact 成功写出。
- 报告包含平台、路径、锁、DuckDB 可用性、表统计和数据集风险。
- DuckDB 不可用时报告明确状态。
- 不发生迁移、drop、归档或查询入口切换。

P2 质量门：

- raw 只追加，无静默覆盖。
- clean 写入幂等。
- 重复键按契约处理，报告有效行数、重复键数量、处理策略和样例。
- Parquet 分区按契约落地，默认按月。
- 小文件超阈值进入压实候选报告。
- 外部化迁移一致性验证通过前，不切换默认入口，不 drop 源表。

P3 质量门：

- 每个数据集有明确热层声明。
- 预检拒绝全局热窗口截断。
- 回测 manifest 能定位输入分区、行数、最大日期、校验和或 ingest 批次。
- 质量例外被记录。
- 锁、写窗口和 UI 句柄限制被执行或明确阻断。

## 需求覆盖矩阵

| 需求 | 设计覆盖 |
| --- | --- |
| 需求 1 原始数据只追加 | Raw 层设计、raw metadata、纠错新批次 |
| 需求 2 清洗标准键、去重、幂等 | 数据集契约、Clean 层设计、质量报告 |
| 需求 3 分区 Parquet 与 DuckDB 查询 | 存储布局、clean 追溯 manifest、分区和文件大小、DuckDB 使用边界 |
| 需求 4 迁移一致性 | 外部化迁移一致性验证 |
| 需求 5 DuckDB 查询引擎和热层 | DuckDB 使用边界、P3 热层治理 |
| 需求 6 回测清单复现 | 回测清单 |
| 需求 7 每日同步增量化 | 每日增量同步流程、P1 增量同步可观测性、P2 raw-clean-mart 流程 |
| 需求 8 预检报告 | P1 预检报告 |
| 需求 9 Agent 协作和锁局限 | 协作锁和资源归属 |
| 需求 10 外部化和 drop 可回滚 | 回滚设计 |
| 需求 11 Windows/macOS | 跨平台设计、路径和文件写入规则 |

## 推进门禁

当前设计草案完成后，Codex 只能运行：

```shell
node tools/ai-coord/spec-state.mjs design-ready --spec data-weight-control
```

随后状态进入 `waiting-claude-review`。Codex 必须等待 Claude 评审。

如果 Claude 返回 `changes-requested`，Codex 读取 `.ai-coord/artifacts/data-weight-control/` 下最新的 `design-review-*.md`，按反馈修改本文档，再次提交评审。

如果 Claude 返回 `accepted-by-claude`，Codex 停止推进，提示人工负责人做最终裁决。
