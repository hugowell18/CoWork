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
const inventoryPath = args.inventory;
const alignmentPath = args.alignment;
const planPath = args.plan;
const rollbackPath = args.rollback;
const outDir = args.outDir || '.ai-coord/artifacts/formal-duckdb-migration/staging-write';
const runId = args.runId || `staging-write-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!dbPath) throw new Error('missing --db');
if (!inventoryPath) throw new Error('missing --inventory');
if (!alignmentPath) throw new Error('missing --alignment');
if (!planPath) throw new Error('missing --plan');
if (!rollbackPath) throw new Error('missing --rollback');

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
    run: (sql) => callbackToPromise((done) => connection.run(sql, done)),
    close: async () => {
      await callbackToPromise((done) => connection.close(done));
      await callbackToPromise((done) => database.close(done));
    },
  };
};

const normalizePath = (file) => file.replaceAll('\\', '/');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const toPlain = (value) => typeof value === 'bigint' ? Number(value) : value;
const rowPlain = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, toPlain(v)]));
const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pathToSql = (file) => sqlString(normalizePath(file));

const canonicalJson = (value) => {
  const canonicalize = (input) => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
};

const assertBoundary = (label, relativePath) => {
  const absolute = path.resolve(workspaceRoot, relativePath);
  const workspaceWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  const quantWithSep = quantRoot.endsWith(path.sep) ? quantRoot : `${quantRoot}${path.sep}`;
  const insideWorkspace = absolute === workspaceRoot || absolute.startsWith(workspaceWithSep);
  const outsideQuantRoot = absolute !== quantRoot && !absolute.startsWith(quantWithSep);
  if (!insideWorkspace || !outsideQuantRoot) {
    throw new Error(`${label} failed boundary check: ${relativePath}`);
  }
  return {
    label,
    relative_path: normalizePath(path.relative(workspaceRoot, absolute)),
    absolute_path: normalizePath(absolute),
    inside_workspace: insideWorkspace,
    outside_quanttrading_source_root: outsideQuantRoot,
  };
};

const ensureEmptyOrAbsentDir = async (dir, label) => {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length) throw new Error(`${label} already exists and is not empty: ${normalizePath(dir)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

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

const safeIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
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
const selectedColumnSql = selectedColumns.map(safeIdent).join(', ');
const sourceFromSql = 'daily_basic';
const sourceWhereSql = "trade_date >= DATE '2026-05-01' AND trade_date < DATE '2026-06-01'";
const sourceOrderSql = 'ts_code, trade_date';
const sourceSelectSql = `SELECT ${selectedColumnSql} FROM ${sourceFromSql} WHERE ${sourceWhereSql}`;
const sourceCopySql = `${sourceSelectSql} ORDER BY ${sourceOrderSql}`;

const rowStringExpr = selectedColumns.map((column) => {
  const ident = safeIdent(column);
  if (column === 'trade_date') return `COALESCE(CAST(${ident} AS VARCHAR), '<NULL>')`;
  if (numericColumns.includes(column)) return `CASE WHEN ${ident} IS NULL THEN '<NULL>' ELSE CAST(CAST(${ident} AS DOUBLE) AS VARCHAR) END`;
  return `COALESCE(CAST(${ident} AS VARCHAR), '<NULL>')`;
}).join(", '\\t', ");

const checksumSql = (fromSql) => `
  SELECT sha256(COALESCE(string_agg(row_text, '\\n' ORDER BY ts_code, trade_date), '')) AS checksum
  FROM (
    SELECT ts_code, trade_date, concat(${rowStringExpr}) AS row_text
    FROM ${fromSql}
  )
`;

const profileSql = (fromSql) => `
  SELECT
    COUNT(*) AS row_count,
    CAST(MIN(trade_date) AS VARCHAR) AS min_date,
    CAST(MAX(trade_date) AS VARCHAR) AS max_date,
    COUNT(ts_code) AS non_null_ts_code,
    COUNT(trade_date) AS non_null_trade_date,
    COUNT(source) AS non_null_source,
    COUNT(ingest_run_id) AS non_null_ingest_run_id,
    APPROX_COUNT_DISTINCT(ts_code) AS approx_distinct_ts_code,
    APPROX_COUNT_DISTINCT(ingest_run_id) AS approx_distinct_ingest_run_id
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
  SELECT 'turnover_rate' AS column_name, COUNT(*) - COUNT(turnover_rate) AS null_count FROM ${fromSql}
  UNION ALL SELECT 'volume_ratio', COUNT(*) - COUNT(volume_ratio) FROM ${fromSql}
  UNION ALL SELECT 'pe', COUNT(*) - COUNT(pe) FROM ${fromSql}
  UNION ALL SELECT 'pb', COUNT(*) - COUNT(pb) FROM ${fromSql}
  UNION ALL SELECT 'ps', COUNT(*) - COUNT(ps) FROM ${fromSql}
  UNION ALL SELECT 'total_mv', COUNT(*) - COUNT(total_mv) FROM ${fromSql}
  UNION ALL SELECT 'circ_mv', COUNT(*) - COUNT(circ_mv) FROM ${fromSql}
  UNION ALL SELECT 'source', COUNT(*) - COUNT(source) FROM ${fromSql}
  UNION ALL SELECT 'ingest_run_id', COUNT(*) - COUNT(ingest_run_id) FROM ${fromSql}
`;

const provenanceSql = (fromSql, column) => `
  SELECT CAST(${safeIdent(column)} AS VARCHAR) AS value, COUNT(*) AS row_count
  FROM ${fromSql}
  GROUP BY ${safeIdent(column)}
  ORDER BY row_count DESC, value
  LIMIT 20
`;

const describeSql = (fromSql) => `DESCRIBE SELECT ${selectedColumnSql} FROM ${fromSql}`;
const structuralSchema = (schemaRows) => schemaRows.map((row) => ({
  column_name: row.column_name,
  column_type: row.column_type,
}));

const inventory = await readJson(inventoryPath);
const alignment = await readJson(alignmentPath);
const plan = await readJson(planPath);
const rollback = await readJson(rollbackPath);

if (plan.pilot?.dataset !== 'daily_basic' || plan.pilot?.partition_id !== 'month=2026-05') {
  throw new Error('pilot plan mismatch; expected daily_basic/month=2026-05');
}
if (rollback.status !== 'rollback-prepared') {
  throw new Error('rollback artifact is not prepared');
}

const stagingPath = plan.target_plan.staging_path;
const cleanManifestPath = plan.target_plan.clean_manifest_path;
const cleanVersionDir = normalizePath(path.dirname(cleanManifestPath));
const parquetRelativePath = `${stagingPath}/part-000.parquet`;
const stagingCheck = assertBoundary('staging_path', stagingPath);
const parquetCheck = assertBoundary('parquet_file', parquetRelativePath);
const cleanManifestCheck = assertBoundary('clean_manifest_path', cleanManifestPath);
const queryEntryCheck = assertBoundary('query_entry_pointer', plan.target_plan.query_entry_pointer);
const cleanCurrentCheck = assertBoundary('clean_current_pointer', `data/clean/${plan.pilot.dataset}/_current.json`);

const stagingDir = path.resolve(workspaceRoot, stagingPath);
const parquetPath = path.resolve(workspaceRoot, parquetRelativePath);
const cleanManifestAbs = path.resolve(workspaceRoot, cleanManifestPath);
const cleanVersionAbs = path.resolve(workspaceRoot, cleanVersionDir);
const queryEntryAbs = path.resolve(workspaceRoot, plan.target_plan.query_entry_pointer);
const cleanCurrentAbs = path.resolve(workspaceRoot, `data/clean/${plan.pilot.dataset}/_current.json`);
const outDirAbs = path.resolve(workspaceRoot, outDir);

await ensureEmptyOrAbsentDir(stagingDir, 'staging directory');
await ensureEmptyOrAbsentDir(cleanVersionAbs, 'clean version directory');

for (const forbiddenPointer of [queryEntryAbs, cleanCurrentAbs]) {
  try {
    await fs.access(forbiddenPointer);
    throw new Error(`forbidden pointer already exists before M4: ${normalizePath(forbiddenPointer)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const sourceDbResolved = path.resolve(dbPath);
const sourceStat = await fs.stat(sourceDbResolved);
if (!sourceStat.isFile()) throw new Error(`source db is not a file: ${dbPath}`);

await fs.mkdir(stagingDir, { recursive: true });
await fs.mkdir(cleanVersionAbs, { recursive: true });

const client = await openReadonly(sourceDbResolved);
let copySucceeded = false;
let copyError = null;
try {
  const versionRows = await client.all('SELECT version() AS version');
  const sourceFrom = `(SELECT ${selectedColumnSql} FROM daily_basic WHERE ${sourceWhereSql})`;
  const sourceProfile = rowPlain((await client.all(profileSql(sourceFrom)))[0]);
  const sourceDuplicate = rowPlain((await client.all(duplicateSql(sourceFrom)))[0]);
  const sourceChecksum = rowPlain((await client.all(checksumSql(sourceFrom)))[0]);
  const sourceNullProfile = (await client.all(nullProfileSql(sourceFrom))).map(rowPlain);
  const sourceProvenance = {};
  for (const column of provenanceColumns) {
    sourceProvenance[column] = (await client.all(provenanceSql(sourceFrom, column))).map(rowPlain);
  }
  const sourceSchema = (await client.all(describeSql(sourceFrom))).map(rowPlain);
  const sourceStructuralSchema = structuralSchema(sourceSchema);
  const sourceFullSchemaHash = sha256Text(canonicalJson(sourceSchema));
  const sourceStructuralSchemaHash = sha256Text(canonicalJson(sourceStructuralSchema));

  const copySql = `COPY (${sourceCopySql}) TO ${pathToSql(parquetPath)} (FORMAT PARQUET)`;
  try {
    await client.run(copySql);
    copySucceeded = true;
  } catch (error) {
    copyError = error;
    throw new Error(`OPEN_READONLY COPY-to-file failed; task must block rather than reopen source writable: ${error.message}`);
  }

  const parquetFrom = `read_parquet(${pathToSql(parquetPath)})`;
  const targetProfile = rowPlain((await client.all(profileSql(parquetFrom)))[0]);
  const targetDuplicate = rowPlain((await client.all(duplicateSql(parquetFrom)))[0]);
  const targetChecksum = rowPlain((await client.all(checksumSql(parquetFrom)))[0]);
  const targetNullProfile = (await client.all(nullProfileSql(parquetFrom))).map(rowPlain);
  const targetProvenance = {};
  for (const column of provenanceColumns) {
    targetProvenance[column] = (await client.all(provenanceSql(parquetFrom, column))).map(rowPlain);
  }
  const targetSchema = (await client.all(describeSql(parquetFrom))).map(rowPlain);
  const targetStructuralSchema = structuralSchema(targetSchema);
  const targetFullSchemaHash = sha256Text(canonicalJson(targetSchema));
  const targetStructuralSchemaHash = sha256Text(canonicalJson(targetStructuralSchema));

  const parquetStat = await fs.stat(parquetPath);
  const parquetFile = {
    path: normalizePath(path.relative(workspaceRoot, parquetPath)),
    absolute_path: normalizePath(parquetPath),
    bytes: parquetStat.size,
    sha256: await sha256File(parquetPath),
    row_count: targetProfile.row_count,
  };
  const combinedChecksum = sha256Text(canonicalJson({
    source_checksum: sourceChecksum.checksum,
    target_checksum: targetChecksum.checksum,
    target_file_sha256: parquetFile.sha256,
    row_count: targetProfile.row_count,
  }));

  const dailyBasicAlignment = alignment.datasets.find((dataset) => dataset.dataset === 'daily_basic');
  const inventoryDailyBasic = inventory.datasets.find((dataset) => dataset.dataset === 'daily_basic');
  const manifest = {
    schema_version: 'clean-version-manifest/v1',
    dataset: 'daily_basic',
    partition_id: 'month=2026-05',
    partition: {
      type: 'month',
      column: 'trade_date',
      value: '2026-05',
    },
    version_id: path.basename(cleanVersionDir),
    version_path: cleanVersionDir,
    manifest_path: normalizePath(cleanManifestPath),
    created_at: new Date().toISOString(),
    created_by: 'codex',
    status: 'quality-pending',
    source: {
      db_alias: plan.inputs.source_db_alias,
      db_observed_path: plan.inputs.source_db_observed_path,
      db_file_size_bytes: sourceStat.size,
      db_last_write_time: sourceStat.mtime.toISOString(),
      table: 'daily_basic',
      connection_mode: 'OPEN_READONLY',
      duckdb_version: versionRows[0]?.version,
      source_sql: sourceSelectSql,
      source_sql_ordered_for_copy: sourceCopySql,
      source_window_predicate: sourceWhereSql,
      source_copy_statement_kind: 'COPY (SELECT ...) TO project-local parquet from OPEN_READONLY connection',
    },
    inputs: {
      baseline_artifact: normalizePath(inventoryPath),
      contract_alignment_artifact: normalizePath(alignmentPath),
      pilot_plan_artifact: normalizePath(planPath),
      rollback_artifact: normalizePath(rollbackPath),
      tasks_revision: 4,
      design_revision: 4,
      requirements_revision: 3,
    },
    contract: {
      contract_path: dailyBasicAlignment.contract_path,
      logical_key: dailyBasicAlignment.canonical.logical_key,
      date_column: dailyBasicAlignment.canonical.date_column,
      selected_columns: selectedColumns,
      numeric_columns: numericColumns,
      provenance_columns: dailyBasicAlignment.provenance_strategy.carried_to_parquet,
      normalization: dailyBasicAlignment.normalization,
      source_schema_hash_from_inventory: inventoryDailyBasic.source_duckdb.schema_hash,
      source_schema_hash_from_alignment: dailyBasicAlignment.source_schema_hash,
    },
    window: plan.pilot.window,
    row_count: targetProfile.row_count,
    expected_row_count: plan.pilot.read_only_profile.row_count,
    duplicate_key_count: targetDuplicate.duplicate_key_count,
    expected_duplicate_key_count: plan.pilot.read_only_profile.duplicate_key_count,
    date_range: {
      from: targetProfile.min_date,
      to: targetProfile.max_date,
    },
    key_non_null: {
      ts_code: targetProfile.non_null_ts_code,
      trade_date: targetProfile.non_null_trade_date,
    },
    checksums: {
      source_ordered_row_sha256: sourceChecksum.checksum,
      target_ordered_row_sha256: targetChecksum.checksum,
      combined_manifest_checksum: combinedChecksum,
      source_full_schema_hash: sourceFullSchemaHash,
      target_full_schema_hash: targetFullSchemaHash,
      source_structural_schema_hash: sourceStructuralSchemaHash,
      target_structural_schema_hash: targetStructuralSchemaHash,
    },
    schema: {
      source: sourceSchema,
      target_parquet: targetSchema,
      source_structural: sourceStructuralSchema,
      target_structural: targetStructuralSchema,
      structural_schema_rule: 'Parquet readback does not preserve DuckDB table constraints such as NOT NULL/PRI; M4 compatibility requires column name and physical type equality.',
    },
    null_profile: {
      source: sourceNullProfile,
      target: targetNullProfile,
    },
    provenance: {
      columns: provenanceColumns,
      source_distribution: sourceProvenance,
      target_distribution: targetProvenance,
      non_null_source: targetProfile.non_null_source,
      non_null_ingest_run_id: targetProfile.non_null_ingest_run_id,
      approx_distinct_ingest_run_id: targetProfile.approx_distinct_ingest_run_id,
      no_fabricated_ingest_provenance: true,
    },
    target_files: [parquetFile],
    m5_ready: {
      status: 'ready-for-consistency-verification',
      required_engine: 'same real DuckDB engine reads source daily_basic and target read_parquet in one verification run',
    },
    forbidden_write_statement: {
      source_duckdb_opened: true,
      source_duckdb_connection_mode: 'OPEN_READONLY',
      source_duckdb_write: false,
      source_duckdb_ddl: false,
      source_duckdb_copy_target: false,
      clean_current_pointer_write: false,
      query_entry_pointer_write: false,
      query_entry_switch: false,
      metadata_dataset_contracts_write: false,
      created_m5_or_later_tasks: false,
    },
  };

  if (manifest.row_count !== 75018 || manifest.duplicate_key_count !== 0) {
    throw new Error(`unexpected staged profile: row_count=${manifest.row_count}, duplicate_key_count=${manifest.duplicate_key_count}`);
  }
  if (manifest.checksums.source_ordered_row_sha256 !== manifest.checksums.target_ordered_row_sha256) {
    throw new Error('source and target row checksum mismatch immediately after staged write');
  }
  if (manifest.checksums.source_structural_schema_hash !== manifest.checksums.target_structural_schema_hash) {
    throw new Error('source and target structural schema hash mismatch immediately after staged write');
  }

  await writeJsonAtomic(cleanManifestAbs, manifest);

  for (const forbiddenPointer of [queryEntryAbs, cleanCurrentAbs]) {
    try {
      await fs.access(forbiddenPointer);
      throw new Error(`forbidden pointer was created during M4: ${normalizePath(forbiddenPointer)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const artifact = {
    artifact_version: 'formal-duckdb-migration/staging-write/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M4-staged-clean-generation',
    task_id: 'T-formal-duckdb-migration-m4-staged-clean-generation',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: 'staged-clean-generated',
    duckdb: {
      availability: 'available',
      engine: 'node-duckdb via Quanttrading node_modules',
      version: versionRows[0]?.version,
      connection_mode: 'OPEN_READONLY',
      source_db_path: normalizePath(sourceDbResolved),
      copy_to_project_local_parquet_succeeded: copySucceeded,
      copy_error: copyError ? copyError.message : null,
    },
    inputs: manifest.inputs,
    pilot: {
      dataset: 'daily_basic',
      partition_id: 'month=2026-05',
      window: plan.pilot.window,
    },
    boundary_checks: {
      workspace_root: normalizePath(workspaceRoot),
      forbidden_source_root: normalizePath(quantRoot),
      targets: [stagingCheck, parquetCheck, cleanManifestCheck, queryEntryCheck, cleanCurrentCheck],
      result: 'passed',
    },
    outputs: {
      staging_path: normalizePath(stagingPath),
      parquet_files: [parquetFile],
      clean_manifest_path: normalizePath(cleanManifestPath),
      clean_version_dir: cleanVersionDir,
      clean_manifest_schema_version: manifest.schema_version,
      clean_manifest_status: manifest.status,
    },
    verification: {
      source_row_count: sourceProfile.row_count,
      target_row_count: targetProfile.row_count,
      source_duplicate_key_count: sourceDuplicate.duplicate_key_count,
      target_duplicate_key_count: targetDuplicate.duplicate_key_count,
      source_ordered_row_sha256: sourceChecksum.checksum,
      target_ordered_row_sha256: targetChecksum.checksum,
      source_full_schema_hash: sourceFullSchemaHash,
      target_full_schema_hash: targetFullSchemaHash,
      source_structural_schema_hash: sourceStructuralSchemaHash,
      target_structural_schema_hash: targetStructuralSchemaHash,
      immediate_source_target_match: true,
    },
    no_write_statement: manifest.forbidden_write_statement,
    decision: {
      result: 'm4-staged-clean-generated-awaiting-claude-review',
      next_allowed_step_after_claude_acceptance: 'Create T-formal-duckdb-migration-m5-consistency-quality-gate only.',
    },
  };

  const renderMarkdown = (item) => `# M4 staged clean generation

- Status: ${item.status}
- Dataset/window: ${item.pilot.dataset} / ${item.pilot.partition_id}
- DuckDB connection: ${item.duckdb.connection_mode}
- Staging path: ${item.outputs.staging_path}
- Parquet: ${item.outputs.parquet_files.map((file) => file.path).join(', ')}
- Clean manifest: ${item.outputs.clean_manifest_path}
- Manifest schema_version: ${item.outputs.clean_manifest_schema_version}
- Manifest status: ${item.outputs.clean_manifest_status}
- Row count: ${item.verification.target_row_count}
- Duplicate key count: ${item.verification.target_duplicate_key_count}
- Boundary checks: ${item.boundary_checks.result}

## Immediate Checks

- Source row count: ${item.verification.source_row_count}
- Target row count: ${item.verification.target_row_count}
- Source checksum: ${item.verification.source_ordered_row_sha256}
- Target checksum: ${item.verification.target_ordered_row_sha256}
- Source structural schema hash: ${item.verification.source_structural_schema_hash}
- Target structural schema hash: ${item.verification.target_structural_schema_hash}

## No-Write Statement

- Source DuckDB write: ${item.no_write_statement.source_duckdb_write}
- Source DuckDB DDL: ${item.no_write_statement.source_duckdb_ddl}
- Source DuckDB copy target: ${item.no_write_statement.source_duckdb_copy_target}
- Clean _current pointer write: ${item.no_write_statement.clean_current_pointer_write}
- Query-entry pointer write: ${item.no_write_statement.query_entry_pointer_write}
- Query-entry switch: ${item.no_write_statement.query_entry_switch}
- Metadata dataset contracts write: ${item.no_write_statement.metadata_dataset_contracts_write}
- M5+ task files created: ${item.no_write_statement.created_m5_or_later_tasks}
`;

  await fs.mkdir(outDirAbs, { recursive: true });
  const artifactJson = path.join(outDirAbs, `${runId}.json`);
  const artifactMd = path.join(outDirAbs, `${runId}.md`);
  await writeJsonAtomic(artifactJson, artifact);
  await fs.writeFile(artifactMd, renderMarkdown(artifact), 'utf8');

  console.log(JSON.stringify({
    status: artifact.status,
    artifact_json: normalizePath(path.relative(workspaceRoot, artifactJson)),
    artifact_md: normalizePath(path.relative(workspaceRoot, artifactMd)),
    manifest: normalizePath(cleanManifestPath),
    parquet: parquetFile.path,
    row_count: manifest.row_count,
    duplicate_key_count: manifest.duplicate_key_count,
    manifest_status: manifest.status,
    boundary_checks: artifact.boundary_checks.result,
  }, null, 2));
} finally {
  await client.close();
}
