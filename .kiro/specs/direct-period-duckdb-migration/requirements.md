# Requirements: direct-period-duckdb-migration

## Status

`draft-for-human-decision`

This spec is a new requirement created by the human owner after the
`formal-duckdb-migration` pilot completed with `decision=keep`.

It intentionally supersedes the previous pilot-only execution policy for the
next migration request. The old `formal-duckdb-migration` artifacts remain the
evidence base, but its limits such as pilot-first expansion, one-window task
gating, Codex-as-implementer, and Claude-as-reviewer do not control this new
spec.

## Human Requirement

Execute a requested DuckDB-to-Parquet migration in one end-to-end batch for the
specified dataset and period, using the implementation pattern that was already
validated by the completed `formal-duckdb-migration` pilot.

For the first run of this spec, the requested target is:

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

The implementation should migrate all source rows in the period into
project-local Parquet and update the production query-entry pointer so routed
queries use Parquet for the migrated period and source DuckDB as fallback for
rows outside the migrated period.

## Role Reversal

This spec reverses the prior implementation/review split:

- Claude is the implementation owner. Claude creates design/task/execution
  artifacts as needed and performs the migration work.
- Codex is the verifier and reviewer. Codex independently reads Claude's
  artifacts, reruns checks against the real source DuckDB and target Parquet,
  and records a review verdict.
- The human owner makes the final decision after Codex review.

Codex must not perform the production migration implementation for this spec
unless the human owner explicitly changes this role split again.

## Rule Override Boundary

This spec skips the previous spec's process rules that forced:

- pilot-first expansion after the completed pilot,
- one task per month/window,
- Claude review after every implementation sub-step,
- Codex as the main implementation owner,
- waiting for new design/tasks gates before execution when the requested
  operation is a direct replay of the already validated playbook.

This override does not authorize unsafe source mutations. It also does not
authorize drop/archive.

## Required Implementation Playbook

Although the work is executed as one end-to-end migration batch, Claude's
implementation must still perform and record the already validated technical
steps:

1. Read the real source DuckDB in `OPEN_READONLY` mode.
2. Inventory the requested dataset/period from the real source table.
3. Reuse or regenerate contract alignment for the requested dataset.
4. Create a rollback snapshot of the current production query-entry pointer.
5. Write staged Parquet for the requested period into project-local paths.
6. Generate `clean-version-manifest/v1` metadata for the staged Parquet.
7. Verify source-vs-target consistency using the same real DuckDB engine
   reading both the source table and `read_parquet` target.
8. Validate row count, date range, key set, duplicate keys, null distribution,
   numeric profile, provenance distribution, checksums, and bidirectional
   `EXCEPT`.
9. Atomically publish the query-entry pointer with temp-file + fsync when
   supported + rename.
10. Immediately run routed smoke and full routed-view observation.
11. If switch smoke fails, roll back to the saved pointer state and record the
    rollback result.

The implementation may combine these into one script or one task, but the
artifact must expose each step's inputs, commands, outputs, and result.

## Safety Requirements

- The source production DuckDB must only be opened in `OPEN_READONLY` mode.
- No source DuckDB write, DDL, writable attach, source-target copy, insert,
  update, delete, drop, or archive is allowed.
- No source table retirement is allowed.
- All writes must be project-local artifacts, staged Parquet, clean manifests,
  and the explicitly approved production query-entry pointer.
- The existing production pointer must be captured before switch and must be
  restorable.
- Failure before switch must leave the old production pointer untouched.
- Failure after switch must either roll back immediately or record a blocked
  state requiring human rollback approval.
- The existing `daily_basic/month=2026-05` pilot Parquet and artifacts are
  evidence, but the full-period run must verify the whole requested period
  against the real source, not assume the pilot result covers the full period.

## Required Outputs From Claude

Claude must produce at least one execution artifact under:

```text
.ai-coord/artifacts/direct-period-duckdb-migration/execution/
```

The artifact must include:

- source database path, open mode, DuckDB/node driver version, and source table,
- requested dataset and period,
- old production pointer snapshot and SHA256,
- new staged Parquet file list, byte sizes, row counts, and SHA256 values,
- clean manifest path and SHA256,
- source/target consistency results,
- pointer publish details,
- switch smoke and post-switch observation results,
- rollback instructions and whether rollback was performed,
- final implementation decision: `implemented`, `rolled-back`, `blocked`, or
  `failed`.

## Codex Review Requirements

Codex must independently verify Claude's result and write a review artifact
under:

```text
.ai-coord/artifacts/direct-period-duckdb-migration/codex-review/
```

Codex review must:

- verify the source DuckDB remained unchanged by size and mtime,
- verify the production query-entry pointer content and SHA256,
- verify target Parquet can be read by DuckDB,
- rerun source-vs-target checks for the requested period,
- rerun routed-view checks for inside-period and outside-period fallback,
- verify rollback instructions are usable,
- verify no drop/archive or source mutation occurred,
- issue one verdict: `accepted`, `changes-requested`, or `blocked`.

## Acceptance Criteria

The human owner may accept the migration only if Codex review says
`accepted`.

For Codex to accept:

- Claude's execution artifact must be complete and parseable.
- The full requested period must match source and target by all required
  consistency checks.
- The routed view must be transparent against the source for the observed
  full dataset.
- Source DuckDB must remain read-only and unchanged.
- Rollback must be documented and mechanically actionable.
- Expansion beyond the requested dataset/period remains out of scope unless the
  human owner creates another direct-period requirement.

## Non-Goals

- Do not migrate all 48 DuckDB tables unless the human owner names them.
- Do not drop or archive source DuckDB tables.
- Do not change source ingestion behavior.
- Do not treat fixture, mock, sandbox, or partial-period verification as
  production success.
