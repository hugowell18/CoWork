#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    args[item.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db;
const quantRoot = path.resolve(args.quantRoot || 'C:/Workspace/Quanttrading/Quanttrading');
const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());
const stagingArtifactPath = args.stagingArtifact;
const manifestPath = args.manifest;
const outVerifyDir = args.verifyOutDir || '.ai-coord/artifacts/formal-duckdb-migration/consistency-verify';
const outQualityDir = args.qualityOutDir || '.ai-coord/artifacts/formal-duckdb-migration/quality-gate';
const runId = args.runId || `quality-gate-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!dbPath) throw new Error('missing --db');
if (!stagingArtifactPath) throw new Error('missing --stagingArtifact');
if (!manifestPath) throw new Error('missing --manifest');

const quantRequire = createRequire(path.join(quantRoot, 'package.json'));
const duckdbModule = quantRequire('duckdb');
const duckdb = duckdbModule.default ?? duckdbModule;

const callbackToPromise = (fn) => new Promise((resolve, reject) => {
  fn((error, result) => error ? reject(error) : resolve(result));
});

const openReadonly = async (file) => {
  const database = await new Promise((resolve, reject) => {
    let db;
    db = new duckdb.Database(file, duckdb.OPEN_READONLY, (error) => error ? reject(error) : resolve(db));
  });
  const connection = database.connect();
  return {
    all: (sql, params = []) => callbackToPromise((done) => {
      if (params.length) connection.all(sql, ...params, done);
      else connection.all(sql, done);
    }),
    close: async () => {
      await callbackToPromise((done) => connection.close(done));
      await callbackToPromise((done) => database.close(done));
    },
  };
};

const normalizePath = (file) => file.replaceAll('\\', '/');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const toPlain = (value) => typeof value === 'bigint' ? Number(value) : value;
const rowPlain = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, toPlain(v)]));
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pathToSql = (file) => sqlString(normalizePath(file));

const canonicalize = (input) => {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key])]));
  }
  return input;
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const writeJsonAtomic = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.tmp`);
  const handle = await fs.open(tmp, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o666);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
};

const assertUnderWorkspace = (label, relativePath) => {
  const absolute = path.resolve(workspaceRoot, relativePath);
  const workspaceWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (absolute !== workspaceRoot && !absolute.startsWith(workspaceWithSep)) {
    throw new Error(`${label} escapes workspace: ${relativePath}`);
  }
  return normalizePath(absolute);
};

const selectedColumns = [
  'ts_code',
  'trade_date',
  'turnover_rate',
  'volume_ratio',
  'pe',
  'pb',
  'ps',
  'total_mv',
  'circ_mv',
  'source',
  'ingest_run_id',
];
const numericColumns = ['turnover_rate', 'volume_ratio', 'pe', 'pb', 'ps', 'total_mv', 'circ_mv'];
const provenanceColumns = ['source', 'ingest_run_id'];
const selectedColumnSql = selectedColumns.join(', ');
const sourceWhereSql = "trade_date >= DATE '2026-05-01' AND trade_date < DATE '2026-06-01'";
const sourceFrom = `(SELECT ${selectedColumnSql} FROM daily_basic WHERE ${sourceWhereSql})`;

const rowStringExpr = selectedColumns.map((column) => {
  if (column === 'trade_date') return `COALESCE(CAST(${column} AS VARCHAR), '<NULL>')`;
  if (numericColumns.includes(column)) return `CASE WHEN ${column} IS NULL THEN '<NULL>' ELSE CAST(CAST(${column} AS DOUBLE) AS VARCHAR) END`;
  return `COALESCE(CAST(${column} AS VARCHAR), '<NULL>')`;
}).join(", '\\t', ");

const checksumSql = (fromSql) => `
  SELECT sha256(COALESCE(string_agg(row_text, '\\n' ORDER BY ts_code, trade_date), '')) AS checksum
  FROM (
    SELECT ts_code, trade_date, concat(${rowStringExpr}) AS row_text
    FROM ${fromSql}
  )
`;

const keySetSql = (fromSql) => `
  SELECT
    COUNT(*) AS key_count,
    sha256(COALESCE(string_agg(key_text, '\\n' ORDER BY key_text), '')) AS key_set_sha256
  FROM (
    SELECT DISTINCT concat(CAST(ts_code AS VARCHAR), '\\t', CAST(trade_date AS VARCHAR)) AS key_text
    FROM ${fromSql}
  )
`;

const profileSql = (fromSql) => `
  SELECT
    COUNT(*) AS row_count,
    CAST(MIN(trade_date) AS VARCHAR) AS min_date,
    CAST(MAX(trade_date) AS VARCHAR) AS max_date,
    COUNT(ts_code) AS non_null_ts_code,
    COUNT(trade_date) AS non_null_trade_date
  FROM ${fromSql}
`;

const duplicateSql = (fromSql) => `
  SELECT COALESCE(SUM(cnt - 1), 0) AS duplicate_key_count
  FROM (
    SELECT ts_code, trade_date, COUNT(*) AS cnt
    FROM ${fromSql}
    GROUP BY ts_code, trade_date
    HAVING COUNT(*) > 1
  )
`;

const nullProfileSql = (fromSql) => `
  SELECT 'ts_code' AS column_name, COUNT(*) - COUNT(ts_code) AS null_count FROM ${fromSql}
  UNION ALL SELECT 'trade_date', COUNT(*) - COUNT(trade_date) FROM ${fromSql}
  UNION ALL SELECT 'turnover_rate', COUNT(*) - COUNT(turnover_rate) FROM ${fromSql}
  UNION ALL SELECT 'volume_ratio', COUNT(*) - COUNT(volume_ratio) FROM ${fromSql}
  UNION ALL SELECT 'pe', COUNT(*) - COUNT(pe) FROM ${fromSql}
  UNION ALL SELECT 'pb', COUNT(*) - COUNT(pb) FROM ${fromSql}
  UNION ALL SELECT 'ps', COUNT(*) - COUNT(ps) FROM ${fromSql}
  UNION ALL SELECT 'total_mv', COUNT(*) - COUNT(total_mv) FROM ${fromSql}
  UNION ALL SELECT 'circ_mv', COUNT(*) - COUNT(circ_mv) FROM ${fromSql}
  UNION ALL SELECT 'source', COUNT(*) - COUNT(source) FROM ${fromSql}
  UNION ALL SELECT 'ingest_run_id', COUNT(*) - COUNT(ingest_run_id) FROM ${fromSql}
`;

const numericProfileSql = (fromSql) => numericColumns.map((column) => `
  SELECT
    '${column}' AS column_name,
    COUNT(${column}) AS non_null_count,
    COUNT(*) - COUNT(${column}) AS null_count,
    MIN(${column}) AS min_value,
    MAX(${column}) AS max_value
  FROM ${fromSql}
`).join(' UNION ALL ');

const provenanceSql = (fromSql, column) => `
  SELECT CAST(${column} AS VARCHAR) AS value, COUNT(*) AS row_count
  FROM ${fromSql}
  GROUP BY ${column}
  ORDER BY row_count DESC, value
  LIMIT 50
`;

const exceptCountSql = (leftSql, rightSql) => `
  SELECT COUNT(*) AS row_count
  FROM (
    SELECT ${selectedColumnSql} FROM ${leftSql}
    EXCEPT
    SELECT ${selectedColumnSql} FROM ${rightSql}
  )
`;

const queryEntryPath = 'metadata/query-entry/daily_basic.json';
const cleanCurrentPath = 'data/clean/daily_basic/_current.json';

const stagingArtifact = await readJson(stagingArtifactPath);
const manifestAbs = assertUnderWorkspace('manifest', manifestPath);
const manifestBefore = await readJson(manifestAbs);
if (manifestBefore.schema_version !== 'clean-version-manifest/v1') throw new Error('manifest schema_version mismatch');
if (manifestBefore.status !== 'quality-pending') throw new Error(`manifest must start quality-pending, got ${manifestBefore.status}`);
if (manifestBefore.dataset !== 'daily_basic' || manifestBefore.partition_id !== 'month=2026-05') {
  throw new Error('manifest dataset/partition mismatch');
}

const parquetFile = manifestBefore.target_files?.[0]?.path;
if (!parquetFile) throw new Error('manifest missing target_files[0].path');
const parquetAbs = assertUnderWorkspace('target parquet', parquetFile);
const targetFrom = `(SELECT ${selectedColumnSql} FROM read_parquet(${pathToSql(parquetAbs)}))`;

const sourceDbStatBefore = await fs.stat(dbPath);
const targetStatBefore = await fs.stat(parquetAbs);
const client = await openReadonly(dbPath);

try {
  const versionRows = await client.all('SELECT version() AS version');
  const sourceProfile = rowPlain((await client.all(profileSql(sourceFrom)))[0]);
  const targetProfile = rowPlain((await client.all(profileSql(targetFrom)))[0]);
  const sourceDuplicate = rowPlain((await client.all(duplicateSql(sourceFrom)))[0]);
  const targetDuplicate = rowPlain((await client.all(duplicateSql(targetFrom)))[0]);
  const sourceChecksum = rowPlain((await client.all(checksumSql(sourceFrom)))[0]);
  const targetChecksum = rowPlain((await client.all(checksumSql(targetFrom)))[0]);
  const sourceKeySet = rowPlain((await client.all(keySetSql(sourceFrom)))[0]);
  const targetKeySet = rowPlain((await client.all(keySetSql(targetFrom)))[0]);
  const sourceNullProfile = (await client.all(nullProfileSql(sourceFrom))).map(rowPlain);
  const targetNullProfile = (await client.all(nullProfileSql(targetFrom))).map(rowPlain);
  const sourceNumericProfile = (await client.all(numericProfileSql(sourceFrom))).map(rowPlain);
  const targetNumericProfile = (await client.all(numericProfileSql(targetFrom))).map(rowPlain);
  const provenance = {};
  for (const column of provenanceColumns) {
    provenance[column] = {
      source: (await client.all(provenanceSql(sourceFrom, column))).map(rowPlain),
      target: (await client.all(provenanceSql(targetFrom, column))).map(rowPlain),
    };
  }
  const sourceMinusTarget = rowPlain((await client.all(exceptCountSql(sourceFrom, targetFrom)))[0]);
  const targetMinusSource = rowPlain((await client.all(exceptCountSql(targetFrom, sourceFrom)))[0]);

  const checks = {
    row_count_equal: sourceProfile.row_count === 75018 && targetProfile.row_count === 75018,
    date_range_equal: sourceProfile.min_date === targetProfile.min_date && sourceProfile.max_date === targetProfile.max_date,
    key_non_null: sourceProfile.non_null_ts_code === 75018 && sourceProfile.non_null_trade_date === 75018 && targetProfile.non_null_ts_code === 75018 && targetProfile.non_null_trade_date === 75018,
    duplicate_keys_zero: sourceDuplicate.duplicate_key_count === 0 && targetDuplicate.duplicate_key_count === 0,
    logical_key_set_equal: sourceKeySet.key_count === targetKeySet.key_count && sourceKeySet.key_set_sha256 === targetKeySet.key_set_sha256,
    ordered_row_checksum_equal: sourceChecksum.checksum === targetChecksum.checksum,
    source_minus_target_zero: sourceMinusTarget.row_count === 0,
    target_minus_source_zero: targetMinusSource.row_count === 0,
    null_distribution_equal: canonicalJson(sourceNullProfile) === canonicalJson(targetNullProfile),
    numeric_profile_equal: canonicalJson(sourceNumericProfile) === canonicalJson(targetNumericProfile),
    provenance_distribution_equal: Object.values(provenance).every((item) => canonicalJson(item.source) === canonicalJson(item.target)),
  };
  checks.all_passed = Object.values(checks).every(Boolean);

  const verifyArtifact = {
    artifact_version: 'formal-duckdb-migration/consistency-verify/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M5-consistency-verification',
    task_id: 'T-formal-duckdb-migration-m5-consistency-quality-gate',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: checks.all_passed ? 'passed' : 'failed',
    duckdb: {
      engine: 'node-duckdb via Quanttrading node_modules',
      version: versionRows[0]?.version,
      connection_mode: 'OPEN_READONLY',
      single_engine_for_source_and_target: true,
      source_db_path: normalizePath(dbPath),
      target_read: 'read_parquet',
    },
    inputs: {
      staging_write_artifact: normalizePath(stagingArtifactPath),
      clean_manifest_path: normalizePath(manifestPath),
      target_parquet: normalizePath(parquetFile),
    },
    scope: {
      dataset: 'daily_basic',
      partition_id: 'month=2026-05',
      window_predicate: sourceWhereSql,
      canonical_columns: selectedColumns,
      excluded_target_columns: ['month'],
      comparison_rule: 'Compare canonical structural columns only; target hive partition month is derived and excluded.',
    },
    source: {
      profile: sourceProfile,
      duplicate_key_count: sourceDuplicate.duplicate_key_count,
      key_set: sourceKeySet,
      ordered_row_sha256: sourceChecksum.checksum,
      null_profile: sourceNullProfile,
      numeric_profile: sourceNumericProfile,
    },
    target: {
      profile: targetProfile,
      duplicate_key_count: targetDuplicate.duplicate_key_count,
      key_set: targetKeySet,
      ordered_row_sha256: targetChecksum.checksum,
      null_profile: targetNullProfile,
      numeric_profile: targetNumericProfile,
    },
    provenance,
    except_counts: {
      source_minus_target: sourceMinusTarget.row_count,
      target_minus_source: targetMinusSource.row_count,
    },
    checks,
  };

  const verifyChecksum = sha256Text(canonicalJson(verifyArtifact));
  const qualityStatus = checks.all_passed ? 'quality-passed' : 'quality-failed';
  const qualityArtifact = {
    artifact_version: 'formal-duckdb-migration/quality-gate/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M5-quality-gate',
    task_id: 'T-formal-duckdb-migration-m5-consistency-quality-gate',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: checks.all_passed ? 'passed' : 'failed',
    decision: {
      result: qualityStatus,
      reason: checks.all_passed ? 'All M5 source-vs-target consistency checks passed.' : 'One or more M5 consistency checks failed.',
      next_allowed_step_after_claude_acceptance: checks.all_passed ? 'Create T-formal-duckdb-migration-m6-switch-proposal-rollback-dry-run only.' : 'Do not create M6; investigate failed checks.',
    },
    consistency_artifact: `${normalizePath(outVerifyDir)}/${runId}.json`,
    consistency_sha256: verifyChecksum,
    manifest_update: {
      manifest_path: normalizePath(manifestPath),
      previous_status: manifestBefore.status,
      new_status: qualityStatus,
      atomic_write: true,
      changed_fields: ['status', 'checksums.quality_gate_sha256', 'quality'],
    },
    no_write_statement: {
      source_duckdb_write: false,
      source_duckdb_ddl: false,
      source_duckdb_copy_target: false,
      target_parquet_write: false,
      clean_current_pointer_write: false,
      query_entry_pointer_write: false,
      query_entry_switch: false,
      created_m6_or_later_tasks: false,
    },
  };
  const qualityChecksum = sha256Text(canonicalJson(qualityArtifact));

  const manifestAfter = {
    ...manifestBefore,
    status: qualityStatus,
    checksums: {
      ...manifestBefore.checksums,
      quality_gate_sha256: qualityChecksum,
      consistency_verify_sha256: verifyChecksum,
    },
    quality: {
      status: qualityStatus,
      verified_at: qualityArtifact.created_at,
      consistency_artifact: qualityArtifact.consistency_artifact,
      quality_artifact: `${normalizePath(outQualityDir)}/${runId}.json`,
      consistency_sha256: verifyChecksum,
      quality_sha256: qualityChecksum,
      checks,
    },
  };

  const verifyMd = `# M5 consistency verification

- Status: ${verifyArtifact.status}
- Dataset/window: daily_basic / month=2026-05
- DuckDB connection: ${verifyArtifact.duckdb.connection_mode}
- Source rows: ${sourceProfile.row_count}
- Target rows: ${targetProfile.row_count}
- Source duplicate keys: ${sourceDuplicate.duplicate_key_count}
- Target duplicate keys: ${targetDuplicate.duplicate_key_count}
- Source minus target: ${sourceMinusTarget.row_count}
- Target minus source: ${targetMinusSource.row_count}
- Source checksum: ${sourceChecksum.checksum}
- Target checksum: ${targetChecksum.checksum}
- Canonical columns only: ${selectedColumns.join(', ')}
- Excluded target column: month
`;

  const qualityMd = `# M5 quality gate

- Status: ${qualityArtifact.status}
- Manifest: ${qualityArtifact.manifest_update.manifest_path}
- Previous manifest status: ${qualityArtifact.manifest_update.previous_status}
- New manifest status: ${qualityArtifact.manifest_update.new_status}
- Atomic manifest update: ${qualityArtifact.manifest_update.atomic_write}
- Consistency checksum: ${qualityArtifact.consistency_sha256}
- Quality checksum: ${qualityChecksum}
- _current write: ${qualityArtifact.no_write_statement.clean_current_pointer_write}
- query-entry write: ${qualityArtifact.no_write_statement.query_entry_pointer_write}
`;

  const verifyDirAbs = path.resolve(workspaceRoot, outVerifyDir);
  const qualityDirAbs = path.resolve(workspaceRoot, outQualityDir);
  await fs.mkdir(verifyDirAbs, { recursive: true });
  await fs.mkdir(qualityDirAbs, { recursive: true });
  const verifyJsonPath = path.join(verifyDirAbs, `${runId}.json`);
  const verifyMdPath = path.join(verifyDirAbs, `${runId}.md`);
  const qualityJsonPath = path.join(qualityDirAbs, `${runId}.json`);
  const qualityMdPath = path.join(qualityDirAbs, `${runId}.md`);
  await writeJsonAtomic(verifyJsonPath, verifyArtifact);
  await fs.writeFile(verifyMdPath, verifyMd, 'utf8');
  await writeJsonAtomic(qualityJsonPath, qualityArtifact);
  await fs.writeFile(qualityMdPath, qualityMd, 'utf8');
  await writeJsonAtomic(manifestAbs, manifestAfter);

  const sourceDbStatAfter = await fs.stat(dbPath);
  const targetStatAfter = await fs.stat(parquetAbs);
  for (const forbidden of [queryEntryPath, cleanCurrentPath]) {
    const absolute = path.resolve(workspaceRoot, forbidden);
    try {
      await fs.access(absolute);
      throw new Error(`forbidden pointer exists after M5: ${forbidden}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (sourceDbStatAfter.mtimeMs !== sourceDbStatBefore.mtimeMs || sourceDbStatAfter.size !== sourceDbStatBefore.size) {
    throw new Error('source DuckDB file changed during M5');
  }
  if (targetStatAfter.mtimeMs !== targetStatBefore.mtimeMs || targetStatAfter.size !== targetStatBefore.size || await sha256File(parquetAbs) !== manifestBefore.target_files[0].sha256) {
    throw new Error('target Parquet changed during M5');
  }

  console.log(JSON.stringify({
    status: qualityArtifact.status,
    manifest_status: manifestAfter.status,
    verify_artifact: normalizePath(path.relative(workspaceRoot, verifyJsonPath)),
    quality_artifact: normalizePath(path.relative(workspaceRoot, qualityJsonPath)),
    row_count: targetProfile.row_count,
    duplicate_key_count: targetDuplicate.duplicate_key_count,
    source_minus_target: sourceMinusTarget.row_count,
    target_minus_source: targetMinusSource.row_count,
    no_current_pointer: true,
    no_query_entry_pointer: true,
  }, null, 2));

  if (!checks.all_passed) process.exitCode = 2;
} finally {
  await client.close();
}
