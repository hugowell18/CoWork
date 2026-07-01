# Direct Period DuckDB Migration Loop

## Active Spec

Active spec: `direct-period-duckdb-migration`

This loop is independent from the existing `codex-loop.md` and
`claude-loop.md`. Do not modify or reinterpret those old loop files when using
this loop.

## Purpose

Run a direct one-batch migration for a human-specified DuckDB dataset and
period, using the already validated DuckDB-to-Parquet migration playbook from
`formal-duckdb-migration`.

Initial target from the requirement:

```text
dataset = daily_basic
source_table = main.daily_basic
date_column = trade_date
period_start = 2026-01-01
period_end_exclusive = 2027-01-01
source_duckdb = C:/Workspace/Quanttrading/Quanttrading/data/quant.duckdb
source_open_mode = OPEN_READONLY
production_query_entry_pointer = metadata/query-entry/daily_basic.json
```

## Role Split

- Claude implements the migration.
- Codex verifies and reviews Claude's result.
- The human owner makes the final decision.

Codex must not implement the migration under this loop unless the human owner
explicitly changes the role split.

Claude must not mark its own implementation accepted. Claude finishes into
Codex review.

## Required Files

Both agents must read:

```text
.kiro/steering/*.md
.kiro/specs/direct-period-duckdb-migration/requirements.md
.kiro/specs/direct-period-duckdb-migration/state.json
```

Useful prior evidence:

```text
.ai-coord/artifacts/formal-duckdb-migration/
metadata/query-entry/daily_basic.json
metadata/dataset-contracts/daily_basic.json
C:/Workspace/Quanttrading/Quanttrading/server/db/query-entry-router.mjs
C:/Workspace/Quanttrading/Quanttrading/server/db/duckdb-client.mjs
```

## Claude Implementation Loop

Claude starts only after the human owner explicitly approves the requirement
for execution.

Claude creates exactly one execution task assigned to `claude` with reviewer
`codex`, unless the human owner changes the target period or dataset first.

Task ID convention:

```text
T-direct-period-duckdb-migration-<dataset>-<period>-execute
```

For the initial target:

```text
T-direct-period-duckdb-migration-daily-basic-2026-execute
```

The task must allow the full end-to-end batch and must require at least:

```text
duckdb
source-duckdb/daily_basic-readonly
data-clean/daily_basic/period=2026
query-entry/daily_basic
artifact/direct-period-duckdb-migration/execution
```

The task must forbid:

```text
source-duckdb-write
source-duckdb-ddl
source-duckdb-copy-target
drop-source-table
archive-source-table
source-ingestion-change
unreviewed-self-acceptance
```

Claude implementation must execute the required playbook from
`requirements.md` in one batch:

1. inventory,
2. contract alignment check,
3. rollback snapshot,
4. staged Parquet write,
5. clean manifest write,
6. source-vs-target consistency verification,
7. query-entry pointer switch,
8. switch smoke,
9. post-switch observation,
10. rollback if switch smoke fails.

Claude writes an execution artifact under:

```text
.ai-coord/artifacts/direct-period-duckdb-migration/execution/
```

Claude then runs:

```powershell
node tools/ai-coord/finish-task.mjs --agent claude --task T-direct-period-duckdb-migration-daily-basic-2026-execute --status done
```

Because the task reviewer is `codex`, this puts the task into
`awaiting-review`.

## Codex Review Loop

Codex does not claim implementation tasks under this loop.

Codex watches for a task assigned to `claude` with:

```text
status = awaiting-review
reviewer = codex
```

When such a task exists, Codex must:

1. Read the task JSON.
2. Read Claude's execution artifact.
3. Independently rerun verification against the real source DuckDB opened
   `OPEN_READONLY` and the target Parquet.
4. Verify source DuckDB size and mtime did not change.
5. Verify the production query-entry pointer and routed view behavior.
6. Verify rollback instructions are actionable.
7. Verify no source drop/archive or source mutation occurred.
8. Write a Codex review artifact under:

```text
.ai-coord/artifacts/direct-period-duckdb-migration/codex-review/
```

Codex records one verdict:

```powershell
node tools/ai-coord/review-task.mjs --agent codex --task T-direct-period-duckdb-migration-daily-basic-2026-execute --verdict accepted --artifact ".ai-coord/artifacts/direct-period-duckdb-migration/codex-review/<review-file>.md"
```

or:

```powershell
node tools/ai-coord/review-task.mjs --agent codex --task T-direct-period-duckdb-migration-daily-basic-2026-execute --verdict changes-requested --artifact ".ai-coord/artifacts/direct-period-duckdb-migration/codex-review/<review-file>.md"
```

or:

```powershell
node tools/ai-coord/review-task.mjs --agent codex --task T-direct-period-duckdb-migration-daily-basic-2026-execute --verdict blocked --artifact ".ai-coord/artifacts/direct-period-duckdb-migration/codex-review/<review-file>.md"
```

## Human Decision

After Codex review:

- `accepted`: human owner may accept the migration.
- `changes-requested`: Claude must revise and resubmit.
- `blocked`: human owner decides whether to roll back, narrow scope, or stop.

No drop/archive is authorized by this loop.

## Waiting Rule

When waiting for the other agent, poll every 10 seconds:

```powershell
node -e "setTimeout(()=>{},10000)"
node tools/ai-coord/status.mjs
```
