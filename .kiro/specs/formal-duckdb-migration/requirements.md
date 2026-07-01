# Requirements: formal-duckdb-migration

## 状态
`draft-for-claude-review`

本轮范围变更：正式迁移不再以预设 clean provenance 或旧 contract 假设作为前置权威，而是以真实 DuckDB 当前状态作为迁移 baseline，再反向校准 requirements、design、tasks 和后续执行产物。旧版 design/tasks 已因该变化失效，必须在本 requirements 被 Claude 接受且人工批准后重新产出。

已知基线事实来自 M0 复跑并已被 Claude 接受：真实源库为 `C:/Workspace/Quanttrading/Quanttrading/data/quant.duckdb`，通过 Quanttrading 工程内 `node-duckdb` 以 `OPEN_READONLY` 打开；DuckDB npm 包版本为 `1.4.4`；源库约 2.6GB，发现 48 张表。候选数据集中 `bar_daily`、`daily_basic`、`moneyflow_daily` 已确认行数、日期范围和重复键检查；`bar_minute` 已确认真实表存在，但旧 contract 的逻辑键 `trade_time` 与真实列 `ts` 不一致。

## 第一原则

- DuckDB 当前真实表、schema、行数、日期范围、可查询性和实际列名是正式迁移的第一事实源。
- 源生产库 `quant.duckdb` 或人工批准的等价真实库在所有阶段都只能以 `OPEN_READONLY` 访问；不得向源库写入、建表、改数据、执行 DDL/DML、可写 `ATTACH`、`COPY`、`INSERT`、`UPDATE`、`DELETE` 或 `DROP`。所有写入只允许发生在项目内 staging/clean/target Parquet 和 artifact；只读打开失败或被迫需要写连接时，任务必须 `blocked`。
- 既有 dataset contract、clean manifest、治理文档和 sandbox 验证只能作为期望模型或参考，不得覆盖真实 DuckDB 事实。
- 缺失既有 `clean-version-manifest/v1` 不再阻塞 M1 选型；它改为迁移过程必须生成并验证的正式产物。
- DuckDB 与 contract 不一致时，不得静默迁移；必须先形成 contract-alignment artifact，明确保留 DuckDB 字段、重命名、类型规范化和查询兼容策略。
- 所有门禁仍保持 requirements -> design -> tasks -> execution，每一跳都要 Claude accepted 和人工批准。

## 目标

把真实 DuckDB 中已确认的数据集，以小窗口、可回滚、可审计方式迁移到契约声明的 Parquet 分区、外部视图或热数据集市模式，并让后续查询入口可以在人工批准后稳定切换。

## 非目标

- 不在 requirements、design 或 tasks 草稿阶段执行 DuckDB 写入、Parquet 发布、query-entry switch、drop 或 archive。
- 不一次性迁移全部表或全部历史窗口。
- 不把 fixture、mock、sandbox rehearsal 或只读库存盘点当作正式迁移成功。
- 不因旧 contract 与 DuckDB 不一致而修改源 DuckDB 数据。
- 不向源生产 DuckDB 执行任何写入、DDL/DML、可写 `ATTACH` 或源库目标 `COPY`；迁移导出只能从只读查询结果写入项目内 staging/clean/target 产物。
- 不在没有真实 DuckDB + 真实目标 Parquet 同引擎验证、Claude 复测和人工批准的情况下切换生产默认查询入口。
- 不在普通迁移任务中 drop/archive 源表；drop/archive 必须是单独批准任务。

## 分工

- Codex 负责主干实施：requirements/design/tasks 修订、迁移脚本、artifact、自动化验证和返工。
- Claude 负责 review 和复测：评审每阶段产物，独立指出阻塞项或接受结果。
- 人工负责人批准 requirements、design、tasks、正式迁移执行、查询入口切换和任何不可逆动作。
- Codex 不绕过 Claude review；Claude 不静默修改 Codex 实现；冲突由人工负责人裁决。

## 需求 1：M0 盘点必须以真实 DuckDB 为权威 baseline

验收标准：
- 盘点必须以 `OPEN_READONLY` 连接真实 `quant.duckdb` 或人工批准的同等真实库，记录打开模式、DuckDB 版本、驱动版本、库路径别名、库大小和失败原因；无法只读打开时，对应 dataset/window 必须 `blocked`。
- 对每个候选 dataset/table 记录真实源表、schema、行数、日期范围、关键列覆盖、重复键数量和当前查询入口。
- 旧 contract 只能作为期望模型参与比对；若与真实 DuckDB 不一致，输出 `contract_alignment_required`，不得把 dataset 伪装成 ready。
- DuckDB 引擎、真实源表或真实 schema 不可访问时，对应 dataset/window 的正式迁移就绪度必须是 `blocked`。

## 需求 2：contract 必须从 DuckDB 事实反向校准

验收标准：
- 迁移前必须产出 contract-alignment artifact，列出 DuckDB 列名、逻辑列名、类型、精度、日期/时间规则、空值规则和主键/排序键。
- `bar_minute` 这类 `ts` 与 `trade_time` 不一致的数据集，必须在设计中明确是保留 `ts`、映射为 `trade_time`、还是修订 contract；未批准前不得进入写入迁移。
- 数值和空值规则以校准后的 contract 为准；跨引擎类型差异必须显式规范化后再比对。
- contract 校准不得伪造历史 ingest provenance；只能引用真实 DuckDB baseline、校准规则和后续生成的质量产物。

## 需求 3：写窗口和资源锁必须具体可执行

验收标准：
- 任何 DuckDB 写、Parquet 发布、view 创建或 query-entry switch 前，任务必须声明具体 `requires`，例如 `duckdb`、`data-migration/bar_daily/2026-06`，不得用模糊通配资源作为实际锁。
- 写窗口必须记录 UI 暂停或只读连接要求、预计写入路径、回滚方式和阻断条件。
- Claude 复测若需要打开 DuckDB，也必须遵守同一锁和写窗口规则，避免与 Codex 并发争用句柄。
- `requires = duckdb` 的默认语义是源 DuckDB 只读连接；任何任务卡都必须把 `source-duckdb-write`、`source-duckdb-ddl`、`source-duckdb-copy-target` 列入 forbidden，除非后续单独 requirements 和人工批准改变该边界。

## 需求 4：clean provenance 是迁移输出，不是迁移前置假设

验收标准：
- 若现有 clean manifest 缺失或与 DuckDB baseline 不一致，迁移流程必须从 DuckDB baseline 生成新的 staged Parquet 和 `clean-version-manifest/v1`。
- 新 manifest 必须记录 source DuckDB table/view、baseline 盘点 artifact、查询 SQL 或过滤窗口、行数、日期范围、schema hash、checksum、质量状态和生成命令。
- 发布 clean 分区只能通过 `_current.json` 或等价 pointer 原子替换完成；失败时保留旧 pointer 和旧查询路径。
- 没有 durable recovery path 的迁移任务必须 `blocked`。

## 需求 5：一致性验证是切换前硬门禁

验收标准：
- 正式 `passed` 必须由同一次真实 DuckDB 引擎验证得出：同时查询真实源 DuckDB 表/视图和真实目标 Parquet 视图或 `read_parquet` 结果。
- 验证至少覆盖行数、主键集合、日期范围、关键数值列、空值分布、重复键数量和排序无关 checksum。
- fixture、sandbox、mock 引擎、手工文本或只比较导出文件不得产生正式 `passed`。
- `passed` 只表示可提交 Claude review 和人工批准，不自动切换入口；`failed` 禁止 switch/drop/archive。

## 需求 6：生产查询入口切换必须单独批准

验收标准：
- query-entry switch 必须是单独任务或单独批准步骤，不得混入普通迁移写入任务。
- 切换前必须具备 accepted 的一致性验证 artifact、rollback artifact、切换前 rollback dry-run、Claude 复测接受记录和人工批准记录。
- 切换后必须执行 smoke query、行数/日期范围复查和回滚演练记录。
- 一个 dataset 跨多窗口半迁移时，design 必须明确按窗口、按 dataset 或兼容视图切换，避免不可解释的混合服务状态。

## 需求 7：drop/archive 源表必须延后且单独批准

验收标准：
- 普通正式迁移任务不得 drop 或 archive 源表。
- drop/archive 只能在稳定观察期结束后，通过单独 requirement/task 或人工批准任务处理。
- drop/archive 前必须再次确认一致性、备份、恢复命令和 rollback window。

## 需求 8：artifact 链必须完整且可复测

验收标准：
- 每阶段必须写 artifact：inventory、contract alignment、migration plan、backup/rollback、staging write、quality gate、consistency verify、switch proposal、post-switch observation。
- artifact 必须使用项目相对路径和 `/` 分隔符；本机绝对路径只能作为环境事实，不得作为唯一引用。
- artifact 必须记录工具版本、平台、锁状态、输入输出路径、执行命令、退出码、结论和阻断原因。
- 所有正式执行 artifact 必须经 Claude review 或复测 accepted 后才能进入下一步。

## 需求 9：迁移顺序必须 pilot-first

验收标准：
- 先选择真实 DuckDB 中已确认、风险最低的 pilot dataset/window；不得从最大表或全历史表开始。
- pilot 可因缺失旧 clean provenance 继续进入计划阶段，但必须在写入前完成 contract alignment，并在发布前生成新的 clean provenance。
- pilot 通过后才能扩大到下一 dataset 或窗口；任何 `failed` 或 `blocked` 都暂停扩展。

## 需求 10：后续产品必须由本 requirements 重新派生

验收标准：
- 旧 design/tasks 中以既有 clean provenance 为前置权威的表述全部失效。
- 新 design 必须从 M0 DuckDB baseline、contract alignment、staged DuckDB-to-Parquet、manifest 生成和真实一致性验证重新设计。
- 新 tasks 必须只创建下一步必要任务，不得跳过 Claude review、人工批准或一次性铺开全量迁移队列。

## Design 必须明确回应

- D1 switch 粒度：按窗口、按 dataset 或兼容视图，以及混合期服务方式。
- D2 DuckDB-to-contract 映射：尤其是 `bar_minute.ts` 与 `trade_time` 的处理。
- D3 clean manifest 生成：如何从 DuckDB baseline 产出 `clean-version-manifest/v1` 和 `quality-passed`。
- D4 数值/空值规范化：关键列精度、日期时间、空值和 checksum 规则。
- D5 切换前 rollback dry-run：证明切回路径在 switch 前可用。
- D6 Claude 复测并发：复测方也遵守 DuckDB 锁、写窗口和只读/写入边界。