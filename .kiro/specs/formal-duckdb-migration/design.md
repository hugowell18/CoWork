# 设计：formal-duckdb-migration

## 状态

`draft-for-claude-review`

本设计对应 requirements revision 3：真实 DuckDB 当前状态是正式迁移 baseline。旧 design/tasks 里以既有 clean provenance 为前置权威的内容失效；本设计从 M0 已接受的真实 DuckDB 盘点反向派生 contract、clean manifest、验证和切换方案。

设计阶段不执行 DB 操作，不创建 `tasks.md`，不创建执行队列，不写 DuckDB、Parquet、query entry、drop 或 archive。

## Baseline 事实

M0 已被 Claude 复测接受，作为本轮设计输入：

- 源库：`quanttrading:data/quant.duckdb`，观测路径 `C:/Workspace/Quanttrading/Quanttrading/data/quant.duckdb`。
- 源库大小：约 2.6GB，发现 48 张表。
- 引擎：Quanttrading 工程内 `node-duckdb`，版本 `v1.4.4`。
- 连接模式：`OPEN_READONLY`。
- 最新 M0 artifact：`.ai-coord/artifacts/formal-duckdb-migration/inventory/inventory-formal-duckdb-migration-2026-07-01t06-00-node-duckdb-rerun.json`。

候选表现状：

| dataset | source table | rows | date range | DuckDB key columns found | current issue |
| --- | --- | ---: | --- | --- | --- |
| `bar_daily` | `bar_daily` | 12,435,353 | 2005-01-04..2026-06-29 | `ts_code`, `trade_date` | no existing clean manifest |
| `bar_minute` | `bar_minute` | 3,225,882 | 2022-01-13..2026-06-12 | `ts_code` only under old contract | old contract expects `trade_time`; source has `ts` |
| `daily_basic` | `daily_basic` | 5,423,540 | 2021-01-04..2026-06-29 | `ts_code`, `trade_date` | no existing clean manifest |
| `moneyflow_daily` | `moneyflow_daily` | 8,732,813 | 2010-01-04..2026-06-29 | `ts_code`, `trade_date` | no existing clean manifest |

旧 M0 的 `formal-clean-provenance-not-found` 在新版 requirements 下不再阻塞进入计划阶段；它变成 staged migration 必须生成和验证的输出。`bar_minute` 的 key/schema 不一致仍是写入前阻塞项，必须先完成 contract alignment。

## 不变量

- 源生产库 `quant.duckdb` 全程只读。所有脚本必须以 `OPEN_READONLY` 打开真实源库；禁止源库写入、DDL/DML、可写 `ATTACH`、源库目标 `COPY`、`INSERT`、`UPDATE`、`DELETE`、`DROP`。
- 所有写入只允许发生在 Cowork 项目内 staging、clean、target Parquet、query-entry pointer 和 artifact 路径。
- `requires = duckdb` 默认含义是源 DuckDB 只读连接；任务卡必须列出 `source-duckdb-write`、`source-duckdb-ddl`、`source-duckdb-copy-target` forbidden token。
- 任何只读打开失败、需要写连接、句柄冲突、目标路径越界、schema 未校准、验证输入缺失，都必须 `blocked`。
- 正式 `passed` 只能来自真实 DuckDB 引擎同一次运行中读取真实源 DuckDB 和真实目标 Parquet。
- query-entry switch、drop/archive 和不可逆清理必须是单独任务和单独人工批准点。

## 总体架构

迁移链分为八个阶段，每阶段都有 artifact，且每个执行 artifact 都要经 Claude 复测 accepted 后才能进入下一阶段。

```text
M0 baseline refresh
M1 contract alignment
M2 pilot plan
M3 rollback preparation
M4 staged DuckDB-to-Parquet + clean manifest generation
M5 consistency verification + quality gate
M6 switch proposal + rollback dry-run
M7 query-entry switch + post-switch observation
M8 deferred drop/archive proposal
```

### M0：baseline refresh

M0 在 execution 阶段重新只读确认 baseline。已接受的 M0 可作为起点，但只要源库 `last_write_time`、行数、schema hash 或 candidate window 发生变化，就必须刷新 M0 artifact。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/inventory/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/inventory/<run-id>.md
```

M0 必须记录：源库 alias、观测绝对路径、库大小、last write time、DuckDB/driver 版本、连接模式、表清单、候选表 schema、行数、日期范围、重复键、旧 contract 对比结果、provenance 列分布。只读打开失败即 `blocked`。

### M1：contract alignment

M1 把 DuckDB 事实反向校准为迁移 contract。它不写源库、不写 clean 数据，只产出 contract-alignment artifact 和后续 contract 修改建议。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/contract-alignment/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/contract-alignment/<run-id>.md
```

M1 对每个 dataset 输出：

- DuckDB 源列、类型、nullable 信息、样例值范围。
- canonical logical columns、primary/logical key、partition key、sort key。
- source-to-target column mapping。
- 数值精度、日期时间、空值、checksum 规范化规则。
- provenance 列处理：`source`、`source_detail`、`ingest_run_id`、`quality_status`、`raw_count`、`updated_at` 若存在，必须携带到 target 或在 manifest 中对账记录，不得伪造历史 ingest provenance。
- 是否需要修改 `metadata/dataset-contracts/<dataset>.json`，以及修改前后差异。

`bar_minute` 的默认设计决策：以 DuckDB 当前状态为准，canonical 时间列使用 `ts`，logical key 修订为 `["ts_code", "ts"]`；若旧消费者需要 `trade_time`，只在 adapter/candidate view 中暴露 `trade_time = ts` 兼容别名，不把 `trade_time` 写成新的源事实。该决策必须经 M1 artifact、Claude review 和人工批准后才能进入写入阶段。

### M2：pilot plan

M2 选择第一个低风险 dataset/window，并把后续写入、验证、切换拆成任务候选。M2 不执行写入。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/plan/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/plan/<run-id>.md
```

默认 pilot 策略：优先选择 key 已匹配、列少、窗口小、非最大表、源日期范围稳定的数据集。当前候选中 `daily_basic` 优先于 `moneyflow_daily` 和 `bar_daily`；`bar_minute` 必须等 M1 contract alignment 批准后再进入 pilot。窗口默认选择一个已闭合月度窗口，不包含源表最大日期，例如刷新 M0 后仍存在的最近完整月份。

M2 必须声明：dataset/window、source SQL、target staging path、clean manifest path、质量门、consistency SQL、switch grain、rollback path、Claude 复测方法、人工批准点。计划不能自动触发写入或切换。
### M3：rollback preparation

M3 在任何 staged 写入前建立恢复路径。它仍然不修改源 DuckDB。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/rollback/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/rollback/<run-id>.md
```

rollback artifact 必须包含：source table、source schema hash、source row/date baseline、target staging path、clean publish pointer 旧值、query-entry pointer 旧值、恢复步骤、目标路径清理策略、失败保留策略、切换前 rollback dry-run 验收标准。

如果没有旧 pointer，artifact 必须记录 `old_pointer = absent`，并说明失败时删除 candidate pointer 或保持“不切换”状态的恢复方式。没有 durable recovery path 时，dataset/window `blocked`。

### M4：staged DuckDB-to-Parquet + clean manifest generation

M4 从只读源 DuckDB 查询结果生成 staged Parquet 和新的 clean manifest。它是新版 requirements 下 clean provenance 的正式来源。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/staging-write/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/staging-write/<run-id>.md
data/staging/formal-duckdb-migration/<dataset>/<window>/<run-id>/*.parquet
data/clean/<dataset>/_versions/<partition-id>/<version-id>/manifest.json
```

合法写入边界：

- 源连接必须是 `OPEN_READONLY`。
- 目标路径必须解析在 Cowork 项目根下，脚本必须在写入前做 realpath/prefix 校验。
- 导出可以使用只读 `SELECT` 结果写项目内 Parquet；若使用 DuckDB `COPY (SELECT ...) TO '<project-target>' (FORMAT PARQUET)`，必须证明连接是 `OPEN_READONLY` 且目标不是源库或源库目录。
- 禁止 persistent view、table、sequence、index、macro 等任何写入源库的 DDL。验证 SQL 默认使用 CTE 或子查询，不在源库创建对象。

clean manifest 采用 `clean-version-manifest/v1`，最小字段：

```json
{
  "schema_version": "clean-version-manifest/v1",
  "dataset": "daily_basic",
  "partition_id": "<partition-id>",
  "version_id": "<version-id>",
  "status": "quality-pending",
  "source_baseline": {
    "inventory_artifact": ".ai-coord/artifacts/formal-duckdb-migration/inventory/<run-id>.json",
    "source_db_alias": "quanttrading:data/quant.duckdb",
    "source_table": "daily_basic",
    "connection_mode": "OPEN_READONLY",
    "source_last_write_time": "<observed>",
    "source_schema_hash": "<hash>"
  },
  "extract": {
    "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "sql_artifact": ".ai-coord/artifacts/formal-duckdb-migration/staging-write/<run-id>.sql",
    "row_count": 0,
    "date_range": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
    "checksum": "<order-independent-checksum>"
  },
  "contract_alignment": ".ai-coord/artifacts/formal-duckdb-migration/contract-alignment/<run-id>.json",
  "provenance_columns": {
    "carried": ["source", "ingest_run_id"],
    "profiled_only": ["quality_status", "updated_at"]
  }
}
```

clean version 路径采用既有 clean 层布局 `_versions/<partition-id>/<version-id>/`；`partition-id` 来自 M2 window 的稳定编码。`schema_version` 必须使用既有约定字段名，保证 backtest/manifest 消费方按 `clean-version-manifest/v1` 校验时可互操作。

`status` 只能在 M5 quality gate 通过、Claude 复测接受后变更为 `quality-passed`。在此之前不得发布 `_current.json` 指向该版本。

provenance 规则：

- 源表已有 `ingest_run_id`、`source`、`source_detail`、`quality_status`、`raw_count`、`updated_at` 时，M4 必须统计非空率、distinct count、异常值和按窗口分布。
- contract 声明需要的 provenance 列必须原样携带到 Parquet。
- contract 未声明但源表有的 provenance 列，必须在 manifest 中记录 profile；是否进入 Parquet 由 M1 contract alignment 决定。
- 若 `quality_status` 存在且发现非通过状态，M5 质量门必须 `failed`，除非人工另行批准缺口接受任务。

### M5：consistency verification + quality gate

M5 形成正式一致性验证结论，并把 clean manifest 从 `quality-pending` 推进到 `quality-passed` 或 `failed`。M5 不切换 query entry。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/consistency-verify/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/consistency-verify/<run-id>.md
.ai-coord/artifacts/formal-duckdb-migration/quality-gate/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/quality-gate/<run-id>.md
```

验证使用同一个真实 DuckDB 引擎运行：

- 源侧：`OPEN_READONLY` 查询真实源表，按 M2 window 和 M1 mapping 生成 canonical 源结果。
- 目标侧：通过 `read_parquet` 读取 M4 staged/clean Parquet。
- SQL 只使用 CTE/subquery，不创建源库持久对象。

校验项：行数、主键集合、日期范围、重复键数量、关键数值列、空值分布、provenance 分布、排序无关 checksum、失败样例。关键数值和空值规则来自 M1 contract alignment，不允许隐式字符串化绕过类型差异。

由于目标 Parquet 是从源 DuckDB 派生，M5 的语义是证明导出、列映射、类型规范化、分区裁剪、provenance 携带和 checksum 生成忠实无损，而不是证明两条独立数据管线互证。对 `bar_minute`，M5 必须专门验证 `ts` canonical key 以及兼容别名 `trade_time = ts` 的行为。

结论：

- `passed`：manifest 可标记 `quality-passed`，可提交 Claude 复测和人工批准下一步 switch proposal。
- `failed`：保留失败样例，禁止 switch/drop/archive。
- `blocked`：工具、锁、句柄、只读源、目标 Parquet 或输入 artifact 不满足正式验证条件。
### M6：switch proposal + rollback dry-run

M6 只提交切换提案和切换前 rollback dry-run，不执行生产切换。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/switch-proposal/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/switch-proposal/<run-id>.md
.ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run/<run-id>.md
```

切换粒度默认是 `dataset/window`。query entry 通过一个单一 pointer 暴露服务状态，不允许消费者自行拼接半迁移配置。

推荐 query-entry pointer：

```json
{
  "entry_version": "query-entry/v1",
  "dataset": "daily_basic",
  "switch_set": [{ "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }],
  "source_mode": "duckdb-readonly-baseline",
  "target_mode": "parquet-clean-version",
  "target_manifest": "data/clean/<dataset>/_versions/<partition-id>/<version-id>/manifest.json",
  "fallback_source": "quanttrading:data/quant.duckdb:<table>",
  "adapter_sql_artifact": ".ai-coord/artifacts/formal-duckdb-migration/switch-proposal/<run-id>.sql",
  "rollback": { "old_pointer_artifact": ".ai-coord/artifacts/formal-duckdb-migration/rollback/<run-id>.json" }
}
```

混合期服务方式：

- 对已切换 window，adapter 从 Parquet clean version 读取。
- 对未切换 window，adapter 从只读源 DuckDB 读取。
- 如果一次查询跨已切换和未切换 window，adapter 使用统一 SQL/路由 artifact 按日期窗口拆分并 union，保持 schema、列顺序、类型和排序规则一致。
- 如果当前查询入口无法实现这种确定性混合路由，则该 dataset 必须改为全 dataset 切换，或者 switch proposal `blocked`。

rollback dry-run 使用 candidate pointer 或非生产 pointer 执行“新值 -> 旧值”的等价替换，证明旧 pointer、旧查询入口、清理命令和权限路径可用。dry-run 不触碰生产入口。无法证明切回路径时，switch proposal `blocked`。

### M7：query-entry switch + post-switch observation

M7 是单独人工批准后的生产切换任务。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/query-entry-switch/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/query-entry-switch/<run-id>.md
.ai-coord/artifacts/formal-duckdb-migration/post-switch-observation/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/post-switch-observation/<run-id>.md
```

M7 前置条件：M5 `passed` 且 Claude accepted，M6 switch proposal accepted，rollback dry-run accepted，人工负责人明确批准。

切换机制：写同目录临时 pointer，flush 后原子替换 query-entry pointer。可观察状态只能是旧入口或新入口。失败时保留旧 pointer 或立即恢复旧 pointer，不允许半切换继续服务。

切换后必须执行 smoke query、新连接或刷新后读取、行数/日期范围复查、关键查询样例、rollback 演练记录。成功切换不代表可以 drop/archive 源表。

### M8：deferred drop/archive proposal

普通迁移不 drop/archive 源表。M8 只能在稳定观察期结束后提出单独提案。

输出：

```text
.ai-coord/artifacts/formal-duckdb-migration/drop-archive-proposal/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/drop-archive-proposal/<run-id>.md
```

M8 需要新的人工批准；源生产库只读不变量仍然有效。任何需要改动源 DuckDB 的 archive/drop 都不属于当前 requirements 自动授权范围，必须另起 requirement 或人工明确扩大边界。

## 锁与并发

执行任务必须声明具体资源：

- `duckdb`：只读源连接，不授予源写入。
- `data-staging/<dataset>/<window>`：staged Parquet 写入。
- `data-clean/<dataset>/<version>`：clean version 写入或 pointer publish。
- `query-entry/<dataset>`：生产入口切换。
- `artifact/formal-duckdb-migration/<stage>`：artifact 写入。

Claude 复测也必须遵守同一锁语义。Codex 持有写入 target Parquet 或 pointer 的窗口时，Claude 不能并发打开会冲突的 writer；Claude 对源 DuckDB 只能使用 `OPEN_READONLY`。

## 任务队列原则

新 tasks 必须小步生成：先 M0 refresh，再 M1 contract alignment，再 M2 pilot plan。不得在 tasks 阶段一次性铺开全量 M3-M8 任务。每个任务的 outputs、forbidden、requires 和验收点都必须来自本设计。

任何阶段 `failed` 或 `blocked` 都停止扩大迁移范围。Codex 不得领取依赖未 accepted artifact 的后续任务。

## Design 回应矩阵

- D1 switch 粒度：默认 `dataset/window`；混合期由单一 query-entry pointer 和 adapter SQL 按窗口路由，无法确定性路由则改全 dataset 或 blocked。
- D2 DuckDB-to-contract 映射：contract 从 DuckDB 反向校准；`bar_minute` 默认 canonical `ts`，`trade_time` 只做兼容别名。
- D3 clean manifest 生成：M4 从只读 DuckDB baseline 生成 staged Parquet 和 `clean-version-manifest/v1`，M5 通过后改为 `quality-passed`；源 provenance 列必须携带或对账。
- D4 数值/空值规范化：M1 产出精度、日期时间、空值和 checksum 规则；M5 按规则验证，禁止隐式宽松通过。
- D5 切换前 rollback dry-run：M6 用 candidate pointer 证明新值可切回旧值，不能用切换后 smoke test 替代。
- D6 Claude 复测并发：Claude 也遵守 `duckdb` 只读语义、target writer 锁和 query-entry 锁。

## 阻塞条件

以下情况必须 `blocked`：

- 源 DuckDB 无法 `OPEN_READONLY` 打开。
- 任何步骤需要源库写连接、源 DDL/DML 或源库目标 COPY。
- target path 不在 Cowork 项目内。
- contract alignment 未 accepted 就进入写入。
- clean manifest 无法记录 source baseline、mapping、checksum 或 provenance 对账。
- 同引擎源/target 验证无法运行。
- switch pointer 无法证明原子替换和 rollback dry-run。
- Claude review 未 accepted 或人工批准缺失。