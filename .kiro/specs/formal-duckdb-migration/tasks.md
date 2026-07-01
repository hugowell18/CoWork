# Tasks: formal-duckdb-migration

## Status

`draft-for-claude-review`

This revision follows accepted T7a and the human routing decision recorded in
`.ai-coord/artifacts/formal-duckdb-migration/routing-decision-option1.md`.

Decision: implement a deterministic dataset/window routing adapter for
`daily_basic/month=2026-05`, then proceed through a fresh rollback artifact,
an atomic production query-entry pointer switch, and immediate post-switch
observation. Acceleration is allowed only through fast review turnover; the
safety gates are not relaxed.

## Completed Baseline

- T0 `T-formal-duckdb-migration-m0-baseline-refresh`: Claude accepted.
- T1 `T-formal-duckdb-migration-m1-contract-alignment`: Claude accepted.
- T2 `T-formal-duckdb-migration-m2-pilot-plan`: Claude accepted.
- T3 `T-formal-duckdb-migration-m3-rollback-preparation`: Claude accepted.
- T4 `T-formal-duckdb-migration-m4-staged-clean-generation`: Claude accepted.
- T5 `T-formal-duckdb-migration-m5-consistency-quality-gate`: Claude accepted; manifest is `quality-passed`.
- T6 `T-formal-duckdb-migration-m6-switch-proposal-rollback-dry-run`: Claude accepted; production switch remained blocked pending routing proof.
- T7a `T-formal-duckdb-migration-m7-route-adapter-proof`: Claude accepted; artifact-local routing passed, production readiness was `blocked-for-production-switch` because no production consumer existed.

## Fixed Pilot Scope

```text
dataset = daily_basic
partition_id = month=2026-05
window_start = 2026-05-01
window_end = 2026-05-31
window_end_exclusive = 2026-06-01
row_count = 75018
duplicate_key_count = 0
source_duckdb = C:/Workspace/Quanttrading/Quanttrading/data/quant.duckdb
source_open_mode = OPEN_READONLY
clean_manifest_path = data/clean/daily_basic/_versions/month=2026-05/pilot-plan-formal-duckdb-migration-2026-07-01t06-45-daily-basic-2026-05-month=2026-05/manifest.json
route_proof = .ai-coord/artifacts/formal-duckdb-migration/route-proof/route-proof-formal-duckdb-migration-2026-07-01t07-50-daily-basic-2026-05.json
switch_readiness = .ai-coord/artifacts/formal-duckdb-migration/switch-readiness/route-proof-formal-duckdb-migration-2026-07-01t07-50-daily-basic-2026-05.json
production_query_entry_pointer = metadata/query-entry/daily_basic.json
quanttrading_duckdb_entry = C:/Workspace/Quanttrading/Quanttrading/server/db/duckdb-client.mjs
```

## Current Revision Scope

This revision may define the following future execution tasks, but queue
creation remains sequential:

1. T7b1 production routing adapter implementation and proof.
2. T7b2 production consumer integration smoke and no-pointer compatibility proof.
3. T7b3 fresh switch rollback preparation.
4. T7b4 atomic production query-entry pointer switch.
5. T7c post-switch observation.

M8 drop/archive remains frozen.

## Global Invariants

- Source production DuckDB is always read-only and may only be opened with `OPEN_READONLY`.
- The source DuckDB file must not be written, attached as a writable target, altered with DDL, copied into as a target, dropped, archived, or used for production default changes outside an explicitly approved switch task.
- Target Parquet and the quality-passed clean manifest for `daily_basic/month=2026-05` are read-only after T5.
- Every task with a reviewer must finish into Claude implementation review. Codex may not continue to the next task until the current task is accepted.
- The 10 second polling rule applies whenever waiting for Claude review.
- Production query-entry pointer writes are allowed only in T7b4, after accepted T7b1, T7b2, T7b3, and explicit human approval for the switch task.
- `data/clean/daily_basic/_current.json` is not part of this pilot switch and must not be written in this revision.
- Drop/archive is not authorized.

## Queue Creation Rules

- After this tasks revision is Claude accepted and human approved, Codex may create only T7b1.
- If T7b1 is accepted, Codex may create T7b2 only.
- If T7b2 is accepted, Codex may create T7b3 only.
- T7b4 may be created only after T7b3 is accepted and the human owner explicitly approves the production pointer switch.
- T7c may be created only after T7b4 is accepted or is in a state that requires immediate observation/rollback evidence.
- If any task is `changes-requested`, `failed`, or `blocked`, do not create later tasks.
- Do not create M8 tasks in this revision.

## T7b1: Production Routing Adapter Implementation And Proof

Task ID: `T-formal-duckdb-migration-m7b1-routing-adapter-implementation`

Purpose: implement the missing production-capable query-entry routing adapter
for `daily_basic/month=2026-05` without enabling a production pointer switch.
The adapter must be able to read a query-entry pointer, route the pilot window
to the quality-passed Parquet manifest, and route dates outside the window to
the source DuckDB opened `OPEN_READONLY`.

Depends on:

- Accepted T7a route proof.
- Human routing decision option 1.
- This tasks revision accepted by Claude and approved by the human owner.

Requires:

- `duckdb`
- `artifact/formal-duckdb-migration/route-proof-read`
- `artifact/formal-duckdb-migration/switch-readiness-read`
- `data-clean/daily_basic/month=2026-05-read`
- `query-entry/daily_basic-read`
- `quanttrading/server-db-adapter`
- `artifact/formal-duckdb-migration/adapter-proof`

Forbidden:

- global forbidden actions
- `production-query-entry-pointer-write`
- `query-entry-switch`
- `clean-current-pointer-write`
- `data-clean-write`
- `target-parquet-write`
- `source-duckdb-write`
- `source-duckdb-ddl`
- `source-duckdb-copy-target`
- `production-default-change`
- `drop-source-table`
- `archive-source-table`
- `.ai-coord/tasks-bulk-create`
- `M7b4-production-switch`

Allowed writes:

```text
C:/Workspace/Quanttrading/Quanttrading/server/db/query-entry-router.mjs
C:/Workspace/Quanttrading/Quanttrading/tests/unit/query-entry-router.test.mjs
.ai-coord/artifacts/formal-duckdb-migration/adapter-proof/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/adapter-proof/<run-id>.md
```

Instructions:

- Inspect `C:/Workspace/Quanttrading/Quanttrading/server/db/duckdb-client.mjs` and existing DuckDB consumers.
- Implement a reusable adapter module near `duckdb-client.mjs`; do not change default production behavior in this task.
- The adapter must support an artifact-local candidate pointer and a future production pointer path.
- For `daily_basic`, it must expose a routed view or query helper with the canonical columns:
  `ts_code`, `trade_date`, `turnover_rate`, `volume_ratio`, `pe`, `pb`, `ps`, `total_mv`, `circ_mv`, `source`, `ingest_run_id`.
- For `2026-05-01 <= trade_date < 2026-06-01`, route to the quality-passed Parquet manifest.
- For dates outside that window, route to `main.daily_basic` in the source DuckDB connection opened `OPEN_READONLY`.
- Invalid or missing date predicates must not silently route to Parquet.
- Cross-window reads must be deterministic and schema-compatible; if implemented as a view, it must use `main.daily_basic` for source fallback to avoid recursive self-reference.
- Write proof artifacts showing route behavior, row counts for pilot window, outside-window fallback smoke, invalid/missing-date behavior, and zero production pointer writes.
- Run targeted Quanttrading tests for the adapter.

Outputs:

```text
C:/Workspace/Quanttrading/Quanttrading/server/db/query-entry-router.mjs
C:/Workspace/Quanttrading/Quanttrading/tests/unit/query-entry-router.test.mjs
.ai-coord/artifacts/formal-duckdb-migration/adapter-proof/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/adapter-proof/<run-id>.md
```

Acceptance:

- Adapter tests pass.
- Artifact-local pointer routes the pilot window to the quality-passed Parquet target.
- Outside-window smoke proves source DuckDB fallback via `OPEN_READONLY`.
- No production pointer is created or modified.
- No `duckdb-client.mjs` production default behavior is changed in T7b1.
- Claude review accepted before T7b2 is created.

## T7b2: Production Consumer Integration Smoke And Compatibility Proof

Task ID: `T-formal-duckdb-migration-m7b2-consumer-integration-smoke`

Purpose: prove that the Quanttrading DuckDB entry can consume query-entry
routing without breaking no-pointer behavior. This task may integrate the
adapter into `duckdb-client.mjs`, but production routing must remain inactive
when no pointer exists.

Depends on:

- Accepted T7b1 adapter proof.

Requires:

- `duckdb`
- `quanttrading/server-db-adapter`
- `artifact/formal-duckdb-migration/adapter-proof-read`
- `artifact/formal-duckdb-migration/consumer-integration-proof`

Forbidden:

- global forbidden actions
- `production-query-entry-pointer-write`
- `query-entry-switch`
- `clean-current-pointer-write`
- `data-clean-write`
- `target-parquet-write`
- `source-duckdb-write`
- `source-duckdb-ddl`
- `source-duckdb-copy-target`
- `drop-source-table`
- `archive-source-table`
- `.ai-coord/tasks-bulk-create`
- `M7b4-production-switch`

Allowed writes:

```text
C:/Workspace/Quanttrading/Quanttrading/server/db/duckdb-client.mjs
C:/Workspace/Quanttrading/Quanttrading/tests/unit/query-entry-router.test.mjs
.ai-coord/artifacts/formal-duckdb-migration/consumer-integration-proof/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/consumer-integration-proof/<run-id>.md
```

Instructions:

- Integrate the adapter only if no-pointer behavior is provably identical to the old `openDuckDb` behavior.
- If an environment flag or explicit option is used, document the activation path and keep the default no-pointer path safe.
- Run no-pointer smoke against the real `quant.duckdb` with `OPEN_READONLY`.
- Run artifact-local pointer smoke proving `daily_basic` reads can resolve through the routed path.
- Record exact consumers affected and any consumers not affected.
- Do not write production query-entry pointer.

Outputs:

```text
.ai-coord/artifacts/formal-duckdb-migration/consumer-integration-proof/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/consumer-integration-proof/<run-id>.md
```

Acceptance:

- Existing no-pointer `openDuckDb` behavior is preserved.
- Routed mode can be enabled deterministically for `daily_basic/month=2026-05`.
- Source DuckDB remains `OPEN_READONLY`.
- No production pointer is created or modified.
- Claude review accepted before T7b3 is created.

## T7b3: Fresh Switch Rollback Preparation

Task ID: `T-formal-duckdb-migration-m7b3-fresh-switch-rollback`

Purpose: capture the exact production pointer state immediately before the
switch task and generate rollback instructions for restoring it.

Depends on:

- Accepted T7b2 consumer integration proof.

Requires:

- `query-entry/daily_basic-read`
- `artifact/formal-duckdb-migration/consumer-integration-proof-read`
- `artifact/formal-duckdb-migration/switch-rollback`

Forbidden:

- global forbidden actions
- `production-query-entry-pointer-write`
- `query-entry-switch`
- `clean-current-pointer-write`
- `data-clean-write`
- `target-parquet-write`
- `source-duckdb-write`
- `drop-source-table`
- `archive-source-table`
- `.ai-coord/tasks-bulk-create`

Allowed writes:

```text
.ai-coord/artifacts/formal-duckdb-migration/switch-rollback/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/switch-rollback/<run-id>.md
```

Instructions:

- Read `metadata/query-entry/daily_basic.json` if present; record absent if absent.
- Validate that T7b1/T7b2 artifacts are accepted and still point to the same quality-passed manifest.
- Build the exact new pointer content but keep it artifact-local.
- Generate rollback commands for old-present and old-absent states.
- Prove no production pointer was modified.

Acceptance:

- Fresh old pointer state is captured.
- New pointer content is artifact-local only.
- Rollback path restores the old-present or old-absent state.
- Claude review accepted and human owner explicitly approves before T7b4 is created.

## T7b4: Atomic Production Query-Entry Pointer Switch

Task ID: `T-formal-duckdb-migration-m7b4-query-entry-switch`

Purpose: atomically publish `metadata/query-entry/daily_basic.json` for the
pilot window after all adapter and rollback gates are accepted.

Depends on:

- Accepted T7b1 adapter proof.
- Accepted T7b2 consumer integration proof.
- Accepted T7b3 fresh rollback artifact.
- Explicit human approval for the production switch task.

Requires:

- `query-entry/daily_basic`
- `artifact/formal-duckdb-migration/switch-rollback-read`
- `artifact/formal-duckdb-migration/query-entry-switch`

Forbidden:

- global forbidden actions
- `clean-current-pointer-write`
- `data-clean-write`
- `target-parquet-write`
- `source-duckdb-write`
- `source-duckdb-ddl`
- `source-duckdb-copy-target`
- `drop-source-table`
- `archive-source-table`
- `.ai-coord/tasks-bulk-create`

Allowed writes:

```text
metadata/query-entry/daily_basic.json
.ai-coord/artifacts/formal-duckdb-migration/query-entry-switch/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/query-entry-switch/<run-id>.md
```

Instructions:

- Before writing, re-read the production pointer and fail if it differs from the T7b3 captured old state.
- Write the new pointer to a temporary file in the same directory, fsync when supported, and atomically rename it to `metadata/query-entry/daily_basic.json`.
- The pointer must reference only the accepted `quality-passed` manifest and the source DuckDB fallback.
- Immediately run a switch smoke using the integrated consumer in `OPEN_READONLY` mode.
- If smoke fails, restore the T7b3 old pointer state and record rollback.
- Do not write `_current.json`.

Acceptance:

- Atomic pointer publish or rollback is recorded.
- Smoke proves pilot-window routed reads and outside-window source fallback.
- No source DuckDB, target Parquet, clean manifest, `_current`, drop, or archive write occurs.
- Claude review accepted before T7c is created.

## T7c: Post-Switch Observation

Task ID: `T-formal-duckdb-migration-m7c-post-switch-observation`

Purpose: observe the switched query-entry path and decide whether to keep,
rollback, or block expansion.

Depends on:

- Accepted or rollback-recorded T7b4.

Requires:

- `duckdb`
- `query-entry/daily_basic-read`
- `artifact/formal-duckdb-migration/query-entry-switch-read`
- `artifact/formal-duckdb-migration/post-switch-observation`

Forbidden:

- global forbidden actions
- `clean-current-pointer-write`
- `data-clean-write`
- `target-parquet-write`
- `source-duckdb-write`
- `source-duckdb-ddl`
- `source-duckdb-copy-target`
- `drop-source-table`
- `archive-source-table`
- `.ai-coord/tasks-bulk-create`

Allowed writes:

```text
.ai-coord/artifacts/formal-duckdb-migration/post-switch-observation/<run-id>.json
.ai-coord/artifacts/formal-duckdb-migration/post-switch-observation/<run-id>.md
```

Instructions:

- Run routed reads for inside-window, outside-window, boundary, invalid-date, and missing-date cases.
- Compare pilot-window row count and date range with the accepted M5 quality gate.
- Confirm outside-window fallback reads source DuckDB `OPEN_READONLY`.
- Record whether to keep the switch, rollback, or block expansion.
- Do not expand migration scope.
- Do not drop or archive source data.

Acceptance:

- Observation artifact clearly states keep, rollback, or blocked.
- If rollback is required, it must be done only through a separately approved rollback task unless T7b4 already performed immediate failure rollback.
- No M8/drop/archive task is created.

## Frozen Future Scope

M8 drop/archive proposal is not part of this revision. Source DuckDB remains
the rollback authority until a later separately approved requirement/design/task
chain authorizes any source retirement.
