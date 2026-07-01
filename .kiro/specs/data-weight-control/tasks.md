# 任务拆解：数据重量控制

## 状态

`draft-for-claude-review`

本文件只描述经评审的实施任务拆解，不创建 `.ai-coord/tasks`，不执行 DB 操作，不触发数据迁移、drop、归档或查询入口切换。

## 门禁

- 依赖：`requirements.md` 已由人工负责人批准，`design.md` 已由 Claude 接受并由人工负责人最终批准。
- 当前阶段：Codex 起草 `tasks.md`，随后交给 Claude 评审。
- Claude 接受且人工负责人最终批准前，不进入执行队列。
- 任何任务执行前必须按任务声明检查 `requires`、`forbidden` 和当前锁状态。
- 高风险动作必须拆成单独任务，并在任务说明中标注人工负责人批准点。

## 任务总览

| 任务 ID | 阶段 | 标题 | 主要输出 |
| --- | --- | --- | --- |
| `T-data-weight-control-p1-contracts` | P1 | 数据集契约与路径规范基础 | 契约 schema、示例契约、路径规范工具 |
| `T-data-weight-control-p1-preflight` | P1 | 零风险预检报告 | preflight JSON/Markdown artifact |
| `T-data-weight-control-p1-incremental-observe` | P1 | 增量同步可观测性 | sync observation artifact |
| `T-data-weight-control-p2-raw-append` | P2 | raw 只追加写入契约 | raw metadata、ingest artifact |
| `T-data-weight-control-p2-clean-partition` | P2 | clean 分区版本化写入 | `_current.json` pointer、版本 manifest |
| `T-data-weight-control-p2-quality-dedup` | P2 | 去重幂等与质量门 | quality JSON/Markdown artifact |
| `T-data-weight-control-p2-daily-sync` | P2 | 每日增量同步编排与 mart 刷新 | sync run artifact、mart refresh artifact |
| `T-data-weight-control-p2-compaction` | P2 | 小文件压实显式流程 | compaction plan、compaction artifact |
| `T-data-weight-control-p2-migration-verify` | P2 | 外部化迁移一致性验证 | migration verify artifact |
| `T-data-weight-control-p2-rollback` | P2 | 外部化和 drop 回滚记录 | rollback artifact |
| `T-data-weight-control-p3-hot-layer` | P3 | DuckDB 热层治理 | hot-layer report |
| `T-data-weight-control-p3-backtest-manifest` | P3 | 回测输入清单 | backtest manifest |
| `T-data-weight-control-p3-locks-write-window` | P3 | 协作锁与写窗口规则 | lock/write-window guidance |

## P1：零风险预检与增量同步可观测性

### T-data-weight-control-p1-contracts

目标：建立 P1/P2/P3 共用的数据集契约、路径规范和跨平台 JSON 读写基础。

要求：

- 定义数据集契约 schema，覆盖 `dataset`、`logical_key`、`date_column`、`partition`、`sort_order`、`dedup`、`usable_scope`、`hot_layer`、`storage`、`small_file`、`strategy_risks`、`migration`。
- 提供第一批示例契约：`bar_daily`、`bar_minute`、`daily_basic`、`moneyflow_daily`。
- 路径持久化统一为项目根目录相对路径和 `/` 分隔符。
- 路径解析必须拒绝绝对路径、空路径和 `..` 越界。
- JSON 写入 UTF-8 无 BOM；读取容忍 UTF-8 BOM、LF 和 CRLF。

资源：

- `requires`: 无。
- `forbidden`: `duckdb`、`data-raw/*`、`data-clean/*`、`data-migration/*`。

输出：

- 契约 schema 或等价校验逻辑。
- 第一批数据集契约示例。
- 路径规范化和 JSON 读写说明。

验收：

- 示例契约能被严格 JSON 解析。
- 契约中不存在 Windows 盘符或 macOS 用户目录。
- 数据集名、路径名、artifact 名称不依赖大小写差异。

### T-data-weight-control-p1-preflight

目标：生成只读预检报告，暴露 DuckDB 表重量、迁移候选、热窗口和策略风险。

要求：

- DuckDB 可用时只读统计表行数、日期覆盖、候选日期列、最近日期、大表或增长风险。
- DuckDB 被锁定、不可用或只读连接失败时，报告明确状态。
- 报告显示每个数据集声明的热窗口，不显示全局热窗口。
- 报告把 `bar_minute`、`moneyflow_daily`、`daily_basic` 标记为第一批治理候选。
- 任意表只要实际使用超出契约 `hot_layer` 用途，必须自动标记为迁移候选。
- 基于契约 `small_file` 阈值检测每个数据集每月文件数和平均文件大小，标记压实候选并写入 artifact。

资源：

- `requires`: 无。只读预检如需要连接 DuckDB，必须先检查 `duckdb` 锁；如果 `duckdb` 锁被其他运行持有，预检必须跳过 DB 连接并报告 `warn` 或 `blocked`，不得以无声明方式打开连接。
- `forbidden`: DuckDB 写入、查询入口切换、drop、归档、数据迁移。

输出：

- `.ai-coord/artifacts/data-weight-control/preflight/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/preflight/<run-id>.md`

验收：

- 报告包含平台、路径解析、工具版本、锁状态、DuckDB 状态、表级统计、数据集级风险和结论。
- DuckDB 不可用时不输出误导性空结果。
- P1 不修改业务数据。

### T-data-weight-control-p1-incremental-observe

目标：只观察每日同步是否具备增量边界，识别全历史刷新、缺口、重复键和旧数据残留风险。

要求：

- 默认观察目标日期或缺口日期，不触发同步。
- 报告最近 ingest run、应同步日期、最近质量报告、热数据集市刷新范围。
- 识别疑似全历史刷新风险。
- 发现重复键、缺口日期、旧数据残留或锁冲突时报告 `warn` 或 `blocked`。

资源：

- `requires`: 无。
- `forbidden`: DuckDB 写入、raw 写入、clean 写入、mart 刷新、全历史重建。

输出：

- 合并进 P1 preflight artifact，或写入 `.ai-coord/artifacts/data-weight-control/preflight/<run-id>.json` 的 `incremental_sync` 节点。

验收：

- 清楚区分“当天/缺口增量同步”和“全历史重建”。
- 全历史重建只作为需人工负责人批准的后续任务候选出现。

## P2：Raw/Clean 分层与 Parquet 落地

### T-data-weight-control-p2-raw-append

目标：实现或定义 raw 层只追加写入与采集元数据记录。

要求：

- 每次采集生成唯一 `ingest_run_id`。
- raw metadata 记录 `source`、`dataset`、`fetch_time`、请求参数、交易日期范围、`usable_scope`。
- 纠错通过新 `ingest_run_id` 和 `correction_of` 或 `supersedes` 表达，不覆盖旧批次。
- raw 不作为策略或回测默认输入。

资源：

- `requires`: `data-raw/<dataset>`。
- `forbidden`: `duckdb` 写入、`data-clean/<dataset>`、drop、归档。

输出：

- raw metadata 结构。
- ingest artifact。

验收：

- 同一 `ingest_run_id` 目录不得静默覆盖。
- `rejected` raw 批次不得进入 clean 有效分区。

### T-data-weight-control-p2-clean-partition

目标：建立 clean 分区版本化写入和跨平台安全的 `_current.json` pointer 机制。

要求：

- clean 默认按月分区，目录形如 `trade_month=YYYY-MM`。
- 新分区版本先写入 `_versions/<partition-id>/<version-id>/`。
- 质量门通过后，用同目录临时文件原子替换 `_current.json`。
- 禁止符号链接、快捷方式、case-only rename 和原地替换 Parquet 目录。
- rename 失败或打开句柄冲突时保留旧 `_current.json` 并报告 `blocked`。

资源：

- `requires`: `data-clean/<dataset>`。
- `forbidden`: drop、归档、生产查询入口切换。

输出：

- clean version manifest。
- `_current.json` pointer。

验收：

- `_current.json` 能定位当前有效版本。
- 版本 manifest 至少包含 `dataset`、`partition_id`、`version_id`、`row_count`、`checksum`、`source_ingest_runs`、`ingest_run_ids`、`quality_artifact`、`previous_version_id`。

### T-data-weight-control-p2-quality-dedup

目标：实现清洗标准层逻辑键、去重、幂等写入和质量门报告。

要求：

- 标准日频默认逻辑键为 `(ts_code, trade_date)`。
- 按契约执行确定性去重，默认 `last-write-wins`。
- 无法确定 winner 时阻断。
- 同一输入批次重复执行，最终有效结果不变。
- 质量门失败时不更新 `_current.json`。

资源：

- `requires`: `data-clean/<dataset>`。
- `forbidden`: drop、归档、生产查询入口切换。

输出：

- `.ai-coord/artifacts/data-weight-control/quality/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/quality/<run-id>.md`

验收：

- 报告包含输入行数、去重前后行数、重复键数量、处理策略、样例、日期范围、空值分布和结论。
- 质量门遇到重复键时不得静默通过。

### T-data-weight-control-p2-daily-sync

目标：把 raw append、clean partition、quality gate 和 mart refresh 编排成端到端每日增量同步流水线。

要求：

- 默认只同步当天或缺口日期，不做全历史刷新。
- 严格按 `raw append -> clean partition -> quality gate -> mart refresh` 顺序执行。
- 任一步失败都必须停止后续步骤，写出失败 artifact，并报告 `blocked` 或 `failed`；不得刷新 mart，不得切换查询入口。
- mart refresh 只刷新契约声明的近期热数据集市或外部视图引用，不把全历史 clean 数据导入 DuckDB。
- mart 输出路径使用 `data/marts/<dataset>/window=<mode>` 或 `window=<mode>-<value>` 命名。
- 全历史重建是独立任务候选，必须由人工负责人明确批准后才能创建和执行；每日同步任务不得把缺口修复扩大成全历史刷新。

资源：

- `requires`: `data-raw/<dataset>`、`data-clean/<dataset>`、`data-mart/<dataset>`。
- `forbidden`: 全历史重建、未经一致性验证和人工批准的生产查询入口切换、drop、归档。

输出：

- `.ai-coord/artifacts/data-weight-control/sync/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/sync/<run-id>.md`
- `.ai-coord/artifacts/data-weight-control/mart-refresh/<run-id>.json`

验收：

- artifact 记录四步执行顺序、每步输入输出、跳过或失败原因、锁状态和最终结论。
- quality gate 未通过时 mart refresh 没有执行。
- refresh 近期 mart 不要求把全历史 clean 数据导入 DuckDB。

### T-data-weight-control-p2-compaction

目标：把小文件压实作为显式任务执行，避免在查询路径或同步路径中静默压实。

要求：

- 输入来自 P1 preflight 的压实候选，不能自动扫描后静默执行。
- 压实只处理契约允许的数据集和月份。
- 压实先写入新的 `_versions/<partition-id>/<version-id>/`，质量门通过后用 `_current.json` 原子发布。
- 压实必须保留旧版本，直到质量报告和回滚窗口结束。
- 压实失败、rename 失败或打开句柄冲突时进入 `blocked`，保留旧 `_current.json`。
- 压实不得触发 drop、归档或生产查询入口切换。

资源：

- `requires`: `data-clean/<dataset>`。
- `forbidden`: drop、归档、生产查询入口切换、查询路径中的静默压实。

输出：

- `.ai-coord/artifacts/data-weight-control/compaction/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/compaction/<run-id>.md`

验收：

- artifact 记录压实前后文件数、平均文件大小、行数、校验和、源版本、目标版本和 `_current.json` 发布结果。
- 压实后逻辑行数和主键集合不变。

### T-data-weight-control-p2-migration-verify

目标：在任何外部化迁移或默认查询入口切换前，证明源 DuckDB 表与目标 Parquet 视图一致。

要求：

- 验证窗口覆盖最新完整月份、边界月份、体量最大月份、策略关键窗口和抽样窗口。
- 验证行数、主键集合、日期范围、关键数值列、空值分布、重复键数量、排序无关校验和。
- 默认在同一 DuckDB 连接中对源表和 Parquet 视图执行同组 SQL 规范化表达式。
- 跨引擎校验必须使用规范化序列化、行哈希和 SHA-256，并用 fixture 证明等价。

资源：

- `requires`: `duckdb`、`data-migration/<dataset>`。
- `forbidden`: drop、归档、生产查询入口切换，除非另有人工批准任务。

输出：

- `.ai-coord/artifacts/data-weight-control/migration-verify/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/migration-verify/<run-id>.md`

验收：

- 验证失败时禁止切换默认入口，禁止 drop 或归档源表。
- artifact 包含验证 SQL、窗口范围、行数、校验和、失败样例和结论。

### T-data-weight-control-p2-rollback

目标：为外部化、归档和 drop 定义可回滚记录。

要求：

- 迁移前保留源表或可恢复备份，直到一致性验证通过且人工负责人批准。
- drop 前必须记录恢复步骤、恢复命令、源表位置、目标分区和一致性验证 artifact。
- 任何不可逆或难以回滚动作必须单独列为人工负责人确认项。

资源：

- `requires`: `data-migration/<dataset>`。
- `forbidden`: 未经人工负责人批准的 drop、归档、不可逆操作。

输出：

- `.ai-coord/artifacts/data-weight-control/rollback/<run-id>.md`

验收：

- 迁移失败时默认回到迁移前查询路径。
- 不允许半切换状态继续服务策略。

## P3：热层治理与回测复现

### T-data-weight-control-p3-hot-layer

目标：按数据集契约治理 DuckDB 热层用途。

要求：

- 不设置全局热窗口。
- `bar_daily` 默认全历史可用。
- `bar_minute` 作为 Parquet 优先和热窗口治理第一候选。
- `daily_basic` 可考虑 DuckDB 外部 Parquet 视图。
- `moneyflow_daily` 迁移前必须证明 symbol 跨历史查询不会退化为高风险全表扫描。
- 超出契约热层用途的表必须标记为迁移候选。

资源：

- `requires`: 如需验证 DuckDB 查询，必须检查或持有 `duckdb` 锁。
- `forbidden`: 未经验证和批准的查询入口切换、drop、归档。

输出：

- `.ai-coord/artifacts/data-weight-control/hot-layer/<run-id>.json`
- `.ai-coord/artifacts/data-weight-control/hot-layer/<run-id>.md`

验收：

- 报告按数据集展示热、温、冷边界。
- 不因全局窗口截断长回看策略需要的数据。

### T-data-weight-control-p3-backtest-manifest

目标：通过 manifest 记录正式回测输入快照，保证可复现。

要求：

- manifest 记录策略版本、代码身份、生成时间。
- 每个输入数据集记录分区路径、行数、最大日期、校验和或采集批次集合。
- `ingest_run_ids` 必须来自 clean 分区 manifest。
- 已接受的数据缺口或质量例外必须显式记录。

资源：

- `requires`: `backtest-manifest/<manifest-id>`。
- `forbidden`: 把每次回测输入全量复制进 DuckDB 作为默认复现机制。

输出：

- `.ai-coord/artifacts/data-weight-control/backtest-manifest/<manifest-id>.json`
- `.ai-coord/artifacts/data-weight-control/backtest-manifest/<manifest-id>.md`

验收：

- manifest 使用项目相对路径。
- manifest 能定位当时的数据字节，或定位等价可重建分区版本。

### T-data-weight-control-p3-locks-write-window

目标：明确协作锁、DuckDB 写窗口和 UI 只读句柄治理。

要求：

- 记录 `duckdb`、`data-raw/<dataset>`、`data-clean/<dataset>`、`data-migration/<dataset>`、`backtest-manifest/<manifest-id>` 等资源使用规则。
- 记录 `data-mart/<dataset>` 资源，用于每日 mart refresh 和热数据集市发布。
- Claude 做 DB 重验证前必须持有或检查 `duckdb` 锁。
- 写窗口内要求相关 UI 暂停、切换只读连接，或通过串行化写入口执行。
- 过期锁可报告但不得静默忽略。
- 不守规矩的进程或 UI 句柄阻塞写入时进入 `blocked`，由人工负责人裁决。
- 资源声明中的 `data-raw/*`、`data-clean/*` 只表示文档层面的资源族禁止项；实际锁文件必须使用具体资源名，例如 `data-clean/bar_daily`，不得用通配锁替代具体锁。

资源：

- `requires`: 无。
- `forbidden`: 将协作型文件锁描述为数据库级强制锁。

输出：

- 协作锁和写窗口说明。
- 必要时补充任务执行模板中的 `requires` / `forbidden` 示例。

验收：

- 每类共享资源都有稳定、可读的小写资源名。
- 锁局限和 Windows/macOS 打开句柄差异被明确说明。
- 通配资源族和具体锁资源的含义被区分清楚。

## 执行顺序

1. 先执行 P1 三项任务，只产生只读报告和配置/契约，不迁移、不 drop、不切换入口。
2. P1 通过后，按数据集选择低风险样本进入 P2；先落地 raw、clean、quality，再用 `T-data-weight-control-p2-daily-sync` 串联每日增量同步。
3. 小文件压实只能通过 `T-data-weight-control-p2-compaction` 显式执行，不得在查询路径中静默触发。
4. 任何外部化迁移都必须先做一致性验证和回滚记录。
5. P2 质量门稳定后进入 P3，治理热层和回测 manifest。
6. 每个高风险动作必须拆出单独批准点，不得合并进普通同步任务。

## 评审关注点

Claude 评审 `tasks.md` 时重点检查：

- 是否严格遵守 P1/P2/P3 分期。
- 是否为每个任务声明资源和禁止事项。
- 是否避免在任务拆解阶段创建 `.ai-coord/tasks` 或执行队列。
- 是否覆盖 design 中的跨平台、去重幂等、分区、可追溯、迁移一致性、回滚、热层、回测 manifest 和锁局限。
- 是否存在会导致静默失败、静默迁移、静默 drop 或跳过人工批准的任务。
