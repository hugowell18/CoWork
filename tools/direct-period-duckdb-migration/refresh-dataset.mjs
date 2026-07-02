#!/usr/bin/env node
import { createRequire } from "node:module";
import { promises as fsp, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDatasetConfig, datasetNames } from "./lib/dataset-registry.mjs";

const toCamelCase = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const parseArgs = (argv) => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const key = toCamelCase(item.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next; i += 1;
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root || process.cwd()).replaceAll("\\", "/");
const QUANT_ROOT = path.resolve(args.quantRoot || "C:/Workspace/Quanttrading/Quanttrading");
const DATASET_NAME = args.dataset;
const CHECK_ONLY = Boolean(args.checkOnly);
const TASK_ID = args.taskId;
const SRC_DB = args.db || path.join(QUANT_ROOT, "data/quant.duckdb").replaceAll("\\", "/");

if (!DATASET_NAME) {
  throw new Error(`missing --dataset. Known datasets: ${datasetNames().join(", ")}`);
}
if (!CHECK_ONLY && !TASK_ID) {
  throw new Error("missing --task-id (required for a real refresh so pointer provenance is traceable to an actual task)");
}

const sha256File = (p) => crypto.createHash("sha256").update(readFileSync(p)).digest("hex");
const sha256Str = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function writeAtomic(absPath, text) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, absPath);
}

const quantRequire = createRequire(path.join(QUANT_ROOT, "package.json"));
const duckdbModule = quantRequire("duckdb");
const duckdb = duckdbModule.default ?? duckdbModule;

(async () => {
  const { config, router } = await getDatasetConfig(DATASET_NAME, QUANT_ROOT);
  const COLSQL = config.canonicalColumns.map((c) => `"${c}"`).join(", ");
  const KEYSQL = config.keyColumns.map((c) => `"${c}"`).join(", ");
  const KEYGROUP = config.keyColumns.map((_, i) => i + 1).join(",");
  const WIN = `trade_date >= DATE '${config.period.start}' AND trade_date < DATE '${config.period.end_exclusive}'`;
  const pointerAbs = path.join(ROOT, `metadata/query-entry/${config.dataset}.json`).replaceAll("\\", "/");

  const db = new duckdb.Database(SRC_DB, duckdb.OPEN_READONLY, (e) => { if (e) { console.error("OPEN:", e.message); process.exit(1); } });
  const con = db.connect();
  const q = (sql) => new Promise((resolve, reject) => con.all(sql, (e, x) => (e ? reject(e) : resolve(x))));

  if (CHECK_ONLY) {
    const report = { dataset: config.dataset, checked_at: new Date().toISOString(), pointer_exists: existsSync(pointerAbs), error: null, drift: null };
    try {
      if (!report.pointer_exists) {
        report.note = "no production query-entry pointer for this dataset yet";
      } else {
        const pointer = router.loadQueryEntryPointer(pointerAbs);
        const { sql } = router[config.buildFn](pointer, { workspaceRoot: ROOT, sourceTable: `main.${config.srcTable}` });
        const routedFull = Number((await q(`SELECT count(*) c FROM (${sql}) t`))[0].c);
        const srcFull = Number((await q(`SELECT count(*) c FROM ${config.srcTable}`))[0].c);
        const rMinusS = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM (${sql}) t EXCEPT SELECT ${COLSQL} FROM ${config.srcTable})`))[0].c);
        const sMinusR = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM ${config.srcTable} EXCEPT SELECT ${COLSQL} FROM (${sql}) t)`))[0].c);
        report.drift = { routedFull, srcFull, rowCountDiff: srcFull - routedFull, rMinusS, sMinusR, hasDrift: routedFull !== srcFull || rMinusS !== 0 || sMinusR !== 0 };
      }
    } catch (e) {
      // --check-only is documented to always exit 0: a corrupt pointer or router validation
      // error must surface as a structured report, not crash the scheduled drift sweep.
      report.error = { message: e.message, code: e.code || null };
      report.drift = { hasDrift: true };
      report.note = "check-only failed with an operational error; treat as needing investigation (reported as drift so a scheduler does not silently skip it)";
    }
    console.log(JSON.stringify(report, null, 2));
    db.close(() => {});
    return;
  }

  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  const RUN_ID = `direct-period-${config.dataset}-refresh-${nowStamp}`;
  const stagingRel = `data/staging/direct-period-duckdb-migration/${config.dataset}/period=full-history/${RUN_ID}`;
  const parquetRel = `${stagingRel}/part-000.parquet`;
  const parquetAbs = path.join(ROOT, parquetRel).replaceAll("\\", "/");
  const versionRel = `data/clean/${config.dataset}/_versions/period=full-history/${RUN_ID}`;
  const manifestRel = `${versionRel}/manifest.json`;
  const manifestAbs = path.join(ROOT, manifestRel).replaceAll("\\", "/");
  const artifactJsonRel = `.ai-coord/artifacts/direct-period-duckdb-migration/execution/${RUN_ID}.json`;
  const artifactJsonAbs = path.join(ROOT, artifactJsonRel).replaceAll("\\", "/");
  const artifactMdRel = `.ai-coord/artifacts/direct-period-duckdb-migration/execution/${RUN_ID}.md`;
  const artifactMdAbs = path.join(ROOT, artifactMdRel).replaceAll("\\", "/");
  const rollbackRel = `.ai-coord/artifacts/direct-period-duckdb-migration/execution/${RUN_ID}.pointer-rollback.json`;
  const rollbackAbs = path.join(ROOT, rollbackRel).replaceAll("\\", "/");
  const RP = () => `read_parquet('${parquetAbs}')`;
  const rowHashExpr = (from) =>
    `SELECT md5(string_agg(rh, '' ORDER BY rh)) AS ck, count(*) c FROM (SELECT md5(concat_ws(chr(31), ${config.canonicalColumns.map((c) => `CAST("${c}" AS VARCHAR)`).join(", ")})) rh FROM ${from}) t`;

  const result = { run_id: RUN_ID, dataset: config.dataset, task_id: TASK_ID, period: config.period, source_db: SRC_DB, open_mode: "OPEN_READONLY", steps: {}, decision: null };
  const srcStatBefore = statSync(SRC_DB);
  result.source_stat_before = { mtime: srcStatBefore.mtime.toISOString(), size: srcStatBefore.size };

  try {
    result.duckdb_version = (await q("SELECT version() v"))[0].v;

    const oldExists = existsSync(pointerAbs);
    const oldBytes = oldExists ? readFileSync(pointerAbs) : null;
    const oldSha = oldExists ? sha256Str(oldBytes.toString()) : null;
    const oldParsed = oldExists ? JSON.parse(oldBytes.toString()) : null;
    writeAtomic(rollbackAbs, JSON.stringify({ old_pointer_existed: oldExists, old_pointer_sha256: oldSha, old_pointer_content: oldParsed }, null, 2));
    result.steps.rollback_snapshot = { old_pointer_existed: oldExists, old_pointer_sha256: oldSha, rollback_file: rollbackRel };

    const inv = (await q(`SELECT count(*) c, strftime(min(trade_date),'%Y-%m-%d') mn, strftime(max(trade_date),'%Y-%m-%d') mx FROM ${config.srcTable} WHERE ${WIN}`))[0];
    const srcDup = Number((await q(`SELECT count(*) c FROM (SELECT ${KEYSQL} FROM ${config.srcTable} WHERE ${WIN} GROUP BY ${KEYGROUP} HAVING count(*)>1)`))[0].c);
    result.steps.inventory = { source_row_count: Number(inv.c), min_date: String(inv.mn), max_date: String(inv.mx), source_duplicate_key_count: srcDup, key_columns: config.keyColumns };

    mkdirSync(path.dirname(parquetAbs), { recursive: true });
    if (!parquetAbs.startsWith(ROOT + "/")) throw new Error("boundary check failed for parquet path");
    await q(`COPY (SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN} ORDER BY ${KEYSQL}) TO '${parquetAbs}' (FORMAT PARQUET)`);
    const pqBytes = statSync(parquetAbs).size;
    const pqSha = sha256File(parquetAbs);
    result.steps.staged_parquet = { path: parquetRel, absolute_path: parquetAbs, bytes: pqBytes, sha256: pqSha };

    const tgt = (await q(`SELECT count(*) c, strftime(min(trade_date),'%Y-%m-%d') mn, strftime(max(trade_date),'%Y-%m-%d') mx FROM ${RP()}`))[0];
    const tgtDup = Number((await q(`SELECT count(*) c FROM (SELECT ${KEYSQL} FROM ${RP()} GROUP BY ${KEYGROUP} HAVING count(*)>1)`))[0].c);
    const sMinusT = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN} EXCEPT SELECT ${COLSQL} FROM ${RP()})`))[0].c);
    const tMinusS = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM ${RP()} EXCEPT SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN})`))[0].c);
    const srcCk = (await q(rowHashExpr(`(SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN})`)))[0];
    const tgtCk = (await q(rowHashExpr(`(SELECT ${COLSQL} FROM ${RP()})`)))[0];
    const nullProf = async (from) => {
      const o = {};
      for (const col of config.numericColumns.concat(["source", "ingest_run_id"])) {
        o[col] = Number((await q(`SELECT count(*) c FROM ${from} WHERE "${col}" IS NULL`))[0].c);
      }
      return o;
    };
    const srcNull = await nullProf(`(SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN}) t`);
    const tgtNull = await nullProf(`${RP()}`);
    const prov = async (from) => {
      const srcRows = await q(`SELECT source v, count(*) n FROM ${from} GROUP BY 1 ORDER BY 1`);
      const ing = Number((await q(`SELECT approx_count_distinct(ingest_run_id) c FROM ${from}`))[0].c);
      return { source_distinct: srcRows.map((r) => ({ value: r.v, row_count: Number(r.n) })), ingest_run_id_distinct: ing };
    };
    const srcProv = await prov(`(SELECT ${COLSQL} FROM ${config.srcTable} WHERE ${WIN}) t`);
    const tgtProv = await prov(`${RP()}`);
    const checks = {
      row_count_equal: Number(inv.c) === Number(tgt.c),
      row_count: Number(tgt.c),
      date_range_equal: String(inv.mn) === String(tgt.mn) && String(inv.mx) === String(tgt.mx),
      duplicate_keys_zero: srcDup === 0 && tgtDup === 0,
      source_minus_target_zero: sMinusT === 0,
      target_minus_source_zero: tMinusS === 0,
      ordered_row_checksum_equal: srcCk.ck === tgtCk.ck,
      null_profile_equal: JSON.stringify(srcNull) === JSON.stringify(tgtNull),
      provenance_equal: JSON.stringify(srcProv) === JSON.stringify(tgtProv),
    };
    checks.all_passed = Object.entries(checks).filter(([k]) => k !== "row_count").every(([, v]) => v === true);
    result.steps.consistency = { source_checksum: srcCk.ck, target_checksum: tgtCk.ck, source_null_profile: srcNull, target_null_profile: tgtNull, source_provenance: srcProv, target_provenance: tgtProv, checks };
    if (!checks.all_passed) {
      result.decision = "failed";
      writeAtomic(artifactJsonAbs, JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      db.close(() => {});
      return;
    }

    const nowIso = new Date().toISOString();
    const manifest = {
      schema_version: "clean-version-manifest/v1",
      dataset: config.dataset,
      partition_id: "period=full-history",
      partition: { type: "period", column: "trade_date", value: "full-history", start: config.period.start, end_exclusive: config.period.end_exclusive },
      version_id: RUN_ID,
      version_path: versionRel,
      manifest_path: manifestRel,
      created_at: nowIso,
      created_by: "claude",
      status: "quality-passed",
      spec: "direct-period-duckdb-migration",
      created_from_task: TASK_ID,
      source: {
        db_alias: "quanttrading:data/quant.duckdb", db_observed_path: SRC_DB, table: config.srcTable,
        connection_mode: "OPEN_READONLY", duckdb_version: result.duckdb_version,
        source_window_predicate: WIN, db_file_size_bytes: statSync(SRC_DB).size, db_last_write_time: statSync(SRC_DB).mtime.toISOString(),
      },
      window: config.period,
      row_count: Number(tgt.c),
      expected_row_count: Number(inv.c),
      duplicate_key_count: tgtDup,
      date_range: { from: String(tgt.mn), to: String(tgt.mx) },
      contract: {
        contract_path: config.contractPath, logical_key: config.keyColumns,
        date_column: "trade_date", selected_columns: config.canonicalColumns, numeric_columns: config.numericColumns, provenance_columns: ["source", "ingest_run_id"],
      },
      checksums: { source_ordered_row_sha256: srcCk.ck, target_ordered_row_sha256: tgtCk.ck, parquet_file_sha256: pqSha },
      null_profile: { source: srcNull, target: tgtNull },
      provenance: { columns: ["source", "ingest_run_id"], source: srcProv, target: tgtProv, no_fabricated_ingest_provenance: true },
      target_files: [{ path: parquetRel, absolute_path: parquetAbs, bytes: pqBytes, sha256: pqSha, row_count: Number(tgt.c) }],
      consistency_checks: checks,
    };
    writeAtomic(manifestAbs, JSON.stringify(manifest, null, 2));
    const manifestSha = sha256File(manifestAbs);
    result.steps.clean_manifest = { path: manifestRel, sha256: manifestSha, status: "quality-passed" };

    const pointer = {
      entry_version: "query-entry/v1",
      dataset: config.dataset,
      switch_grain: "dataset/period",
      status: "production-active-direct-period-full-history",
      created_from_task: TASK_ID,
      created_by: "claude",
      created_at: nowIso,
      route: {
        dataset: config.dataset,
        partition_id: "period=full-history",
        window: config.period,
        target_manifest: manifestRel,
        canonical_columns: config.canonicalColumns,
        source_fallback_required_outside_window: true,
      },
      source_fallback: { source_table: `main.${config.srcTable}`, mode: "duckdb-readonly" },
      // Same run-id used for the pointer, manifest, parquet, and this execution artifact -- no
      // separate timestamp generation for the artifact path (root cause of a prior dangling-reference bug).
      provenance: { clean_manifest: manifestRel, execution_artifact: artifactJsonRel, rollback_snapshot: rollbackRel },
    };
    const newText = JSON.stringify(pointer, null, 2);
    const newSha = sha256Str(newText);

    try {
      await router[config.normalizeFn](pointer, { workspaceRoot: ROOT, sourceTable: `main.${config.srcTable}`, checkTargetFiles: true });
      result.steps.pointer_prevalidation = { ok: true };
    } catch (e) {
      result.steps.pointer_prevalidation = { ok: false, error: e.message };
      result.decision = "blocked";
      result.error = "pointer failed router validation before publish: " + e.message;
      writeAtomic(artifactJsonAbs, JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      db.close(() => {});
      return;
    }

    writeAtomic(pointerAbs, newText);
    const publishedSha = sha256File(pointerAbs);
    result.steps.publish = { pointer: `metadata/query-entry/${config.dataset}.json`, published_sha256: publishedSha, matches_intended: publishedSha === newSha, temp_fsync_atomic_rename: true };

    const p = router.loadQueryEntryPointer(pointerAbs);
    const cls = (d) => router[config.classifyFn](p, d, { workspaceRoot: ROOT, sourceTable: `main.${config.srcTable}` });
    const cases = {
      inside_start_year: cls(`${config.period.start.slice(0, 4)}-06-15`),
      boundary_start: cls(config.period.start),
      boundary_end_excl: cls(config.period.end_exclusive),
      before: cls(new Date(new Date(config.period.start).getTime() - 86400000).toISOString().slice(0, 10)),
      invalid: cls("2026-13-01"),
      missing: cls(null),
    };
    const { sql } = router[config.buildFn](p, { workspaceRoot: ROOT, sourceTable: `main.${config.srcTable}` });
    const cnt = async (where) => Number((await q(`SELECT count(*) c FROM (${sql}) t WHERE ${where}`))[0].c);
    const src = async (where) => Number((await q(`SELECT count(*) c FROM ${config.srcTable} WHERE ${where}`))[0].c);
    const routedFull = await cnt("1=1"), srcFull = await src("1=1");
    const rMinusS = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM (${sql}) t EXCEPT SELECT ${COLSQL} FROM ${config.srcTable})`))[0].c);
    const sMinusR = Number((await q(`SELECT count(*) c FROM (SELECT ${COLSQL} FROM ${config.srcTable} EXCEPT SELECT ${COLSQL} FROM (${sql}) t)`))[0].c);

    const recentDates = (await q(`SELECT DISTINCT strftime(trade_date,'%Y-%m-%d') d FROM ${config.srcTable} WHERE ${WIN} ORDER BY 1 DESC LIMIT 10`)).map((r) => r.d);
    const freshnessByDate = [];
    for (const d of recentDates) {
      const rC = await cnt(`trade_date = DATE '${d}'`);
      const sC = await src(`trade_date = DATE '${d}'`);
      freshnessByDate.push({ date: d, routed: rC, source: sC, equal: rC === sC });
    }
    const freshnessAllEqual = freshnessByDate.every((r) => r.equal);

    const smokeChecks = {
      inside_routes_parquet: cases.inside_start_year.route_type === "parquet-manifest",
      boundary_start_parquet: cases.boundary_start.route_type === "parquet-manifest",
      boundary_end_excl_source: cases.boundary_end_excl.route_type === "source-duckdb",
      before_source: cases.before.route_type === "source-duckdb",
      invalid_rejected: cases.invalid.route_type === "rejected",
      missing_unresolved: cases.missing.route_type === "unresolved",
      routed_full_equals_source: routedFull === srcFull,
      routed_minus_source_zero: rMinusS === 0,
      source_minus_routed_zero: sMinusR === 0,
      freshness_recent_dates_equal: freshnessAllEqual,
    };
    smokeChecks.all_passed = Object.values(smokeChecks).every((v) => v === true);
    result.steps.smoke = { cases, counts: { routedFull, srcFull }, except: { rMinusS, sMinusR }, freshness_by_date: freshnessByDate, checks: smokeChecks };

    if (!smokeChecks.all_passed) {
      const snap = JSON.parse(readFileSync(rollbackAbs, "utf8"));
      if (snap.old_pointer_existed) writeAtomic(pointerAbs, JSON.stringify(snap.old_pointer_content, null, 2));
      else { try { await fsp.unlink(pointerAbs); } catch { /* pointer already absent */ } }
      result.steps.rollback = { performed: true, restored_to_old: snap.old_pointer_existed };
      result.decision = "rolled-back";
    } else {
      result.decision = "implemented";
    }

    const st = statSync(SRC_DB);
    result.source_stat_after = { mtime: st.mtime.toISOString(), size: st.size };
    result.source_unchanged_by_us = result.source_stat_before.mtime === st.mtime.toISOString();
    result.new_pointer_sha256 = newSha;
    result.published_pointer_sha256 = publishedSha;

    writeAtomic(artifactJsonAbs, JSON.stringify(result, null, 2));
    writeAtomic(artifactMdAbs, renderMarkdown(result, config));
    console.log(JSON.stringify(result));
  } catch (e) {
    result.error = `${e.message}\n${e.stack}`;
    if (!result.decision) result.decision = "failed";
    writeAtomic(artifactJsonAbs, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    db.close(() => {});
  }
})();

function renderMarkdown(result, config) {
  const c = result.steps.consistency?.checks ?? {};
  const s = result.steps.smoke?.checks ?? {};
  const counts = result.steps.smoke?.counts ?? {};
  return `# Execution Artifact: ${config.dataset} refresh (tool-generated)

- Task: \`${result.task_id}\`
- Run ID: \`${result.run_id}\`
- Decision: **${result.decision}**
- Generated by: \`tools/direct-period-duckdb-migration/refresh-dataset.mjs\`

## Source

- \`${result.source_db}\`, opened \`OPEN_READONLY\` only.
- Source stat before: ${JSON.stringify(result.source_stat_before)}
- Source stat after: ${JSON.stringify(result.source_stat_after)}
- Unchanged by this process: ${result.source_unchanged_by_us}

## Inventory

${JSON.stringify(result.steps.inventory, null, 2)}

## Consistency checks

\`\`\`json
${JSON.stringify(c, null, 2)}
\`\`\`

## Routed smoke + freshness

\`\`\`json
${JSON.stringify(s, null, 2)}
\`\`\`

Counts: routed full = ${counts.routedFull}, source full = ${counts.srcFull}.

## Rollback

- Snapshot: \`${result.steps.rollback_snapshot?.rollback_file}\`
- Old pointer existed: ${result.steps.rollback_snapshot?.old_pointer_existed}
- Rollback performed: ${result.steps.rollback ? result.steps.rollback.performed : false}

## Forbidden actions confirmed not taken

No source DuckDB write/DDL/copy-target, no drop/archive, no source ingestion change. Only \`data/staging/direct-period-duckdb-migration/${config.dataset}/**\`, \`data/clean/${config.dataset}/_versions/**\`, \`metadata/query-entry/${config.dataset}.json\`, and this execution artifact were written.
`;
}
