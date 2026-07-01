#!/usr/bin/env node
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
const quantRoot = args.quantRoot || 'C:/Workspace/Quanttrading/Quanttrading';
const contractsDir = args.contractsDir || 'metadata/dataset-contracts';
const outDir = args.outDir || '.ai-coord/artifacts/formal-duckdb-migration/inventory';
const runId = args.runId || `inventory-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!dbPath) throw new Error('missing --db');

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

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const safeIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
};
const toPlain = (value) => typeof value === 'bigint' ? Number(value) : value;
const rowPlain = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, toPlain(v)]));
const hashJson = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PROVENANCE_COLUMNS = ['source', 'source_detail', 'ingest_run_id', 'quality_status', 'raw_count', 'updated_at'];

const loadContracts = async () => {
  const entries = await fs.readdir(contractsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'schema.json') continue;
    const contract = await readJson(path.join(contractsDir, entry.name));
    out.push({ path: `${contractsDir.replaceAll('\\', '/')}/${entry.name}`, contract });
  }
  return out.sort((a, b) => a.contract.dataset.localeCompare(b.contract.dataset));
};

const tableExists = async (client, tableName) => {
  const rows = await client.all(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      AND lower(table_name) = lower(?)
    ORDER BY table_schema, table_name
  `, [tableName]);
  return rows[0]?.table_name || null;
};

const tableColumns = async (client, tableName) => {
  const rows = await client.all(`
    SELECT column_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE lower(table_name) = lower(?)
    ORDER BY ordinal_position
  `, [tableName]);
  return rows.map(rowPlain);
};

const provenanceProfile = async (client, tableName, columns) => {
  const table = safeIdent(tableName);
  const columnSet = new Set(columns.map((c) => String(c.column_name).toLowerCase()));
  const profiles = {};
  for (const column of PROVENANCE_COLUMNS) {
    if (!columnSet.has(column.toLowerCase())) continue;
    const ident = safeIdent(column);
    const summary = rowPlain((await client.all(`
      SELECT
        COUNT(*) AS row_count,
        COUNT(${ident}) AS non_null_count,
        APPROX_COUNT_DISTINCT(${ident}) AS approx_distinct_count
      FROM ${table}
    `))[0]);
    const values = ['source', 'source_detail', 'quality_status'].includes(column)
      ? (await client.all(`
          SELECT CAST(${ident} AS VARCHAR) AS value, COUNT(*) AS row_count
          FROM ${table}
          GROUP BY ${ident}
          ORDER BY row_count DESC, value
          LIMIT 20
        `)).map(rowPlain)
      : [];
    profiles[column] = { ...summary, top_values: values };
  }
  return profiles;
};

const tableStats = async (client, tableName, contract) => {
  const table = safeIdent(tableName);
  const columns = await tableColumns(client, tableName);
  const columnSet = new Set(columns.map((c) => String(c.column_name).toLowerCase()));
  const dateColumn = contract.date_column && columnSet.has(String(contract.date_column).toLowerCase())
    ? safeIdent(contract.date_column)
    : null;
  const keyColumns = (contract.logical_key || []).filter((c) => columnSet.has(String(c).toLowerCase())).map(safeIdent);
  const countExpr = dateColumn
    ? `COUNT(*) AS row_count, CAST(MIN(${dateColumn}) AS VARCHAR) AS min_date, CAST(MAX(${dateColumn}) AS VARCHAR) AS max_date`
    : `COUNT(*) AS row_count, NULL AS min_date, NULL AS max_date`;
  const stats = rowPlain((await client.all(`SELECT ${countExpr} FROM ${table}`))[0]);
  let duplicateKeyCount = null;
  if (keyColumns.length === (contract.logical_key || []).length && keyColumns.length > 0) {
    const dup = rowPlain((await client.all(`
      SELECT COALESCE(SUM(cnt - 1), 0) AS duplicate_key_count
      FROM (
        SELECT ${keyColumns.join(', ')}, COUNT(*) AS cnt
        FROM ${table}
        GROUP BY ${keyColumns.join(', ')}
        HAVING COUNT(*) > 1
      )
    `))[0]);
    duplicateKeyCount = dup.duplicate_key_count;
  }
  const expectedKeys = contract.logical_key || [];
  const foundKeyNames = expectedKeys.filter((c) => columnSet.has(String(c).toLowerCase()));
  return {
    columns,
    schema_hash: hashJson(columns),
    stats,
    date_column_found: Boolean(dateColumn),
    logical_key_columns_expected: expectedKeys,
    logical_key_columns_found: foundKeyNames,
    logical_key_columns_missing: expectedKeys.filter((c) => !columnSet.has(String(c).toLowerCase())),
    duplicate_key_count: duplicateKeyCount,
    provenance_profile: await provenanceProfile(client, tableName, columns),
  };
};

await fs.mkdir(outDir, { recursive: true });
const dbStat = await fs.stat(dbPath);
const client = await openReadonly(dbPath);
try {
  const versionRows = await client.all('SELECT version() AS version');
  const databaseRows = await client.all('PRAGMA database_list');
  const allTables = (await client.all(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    ORDER BY table_schema, table_name
  `)).map(rowPlain);
  const contracts = await loadContracts();
  const datasets = [];
  for (const { path: contractPath, contract } of contracts) {
    const actualTable = await tableExists(client, contract.dataset);
    let source = { status: 'blocked', reason: 'table not found', table_or_view: contract.dataset };
    if (actualTable) {
      const inspected = await tableStats(client, actualTable, contract);
      source = {
        status: 'confirmed',
        table_or_view: actualTable,
        row_count: inspected.stats.row_count,
        date_range: { from: inspected.stats.min_date, to: inspected.stats.max_date },
        columns: inspected.columns,
        schema_hash: inspected.schema_hash,
        date_column_found: inspected.date_column_found,
        logical_key_columns_expected: inspected.logical_key_columns_expected,
        logical_key_columns_found: inspected.logical_key_columns_found,
        logical_key_columns_missing: inspected.logical_key_columns_missing,
        duplicate_key_count: inspected.duplicate_key_count,
        provenance_profile: inspected.provenance_profile,
      };
    }
    const cleanPath = contract.storage?.clean_path;
    const cleanCandidates = cleanPath ? [
      { root: 'cowork', currentPath: path.join(cleanPath, '_current.json') },
      { root: 'quanttrading', currentPath: path.join(quantRoot, cleanPath, '_current.json') },
    ] : [];
    const cleanChecks = [];
    let cleanExists = false;
    for (const candidate of cleanCandidates) {
      let exists = false;
      try { await fs.stat(candidate.currentPath); exists = true; } catch {}
      cleanChecks.push({ ...candidate, exists });
      cleanExists = cleanExists || exists;
    }
    const blockedReasons = [];
    const alignmentReasons = [];
    const futureOutputs = [];
    if (!actualTable) blockedReasons.push('real-source-table-not-confirmed');
    if (actualTable && source.date_column_found === false) blockedReasons.push('contract-date-column-not-found-in-source');
    if (actualTable && (source.logical_key_columns_found?.length ?? 0) !== (contract.logical_key || []).length) {
      alignmentReasons.push('contract-logical-key-not-fully-found-in-source');
    }
    if (!cleanExists) futureOutputs.push('clean-version-manifest/v1-quality-passed');
    const baselineStatus = blockedReasons.length
      ? 'blocked'
      : alignmentReasons.length
        ? 'contract-alignment-required'
        : 'ready-for-alignment';
    datasets.push({
      dataset: contract.dataset,
      contract_path: contractPath,
      migration_candidate: Boolean(contract.migration?.candidate),
      baseline_status: baselineStatus,
      source_duckdb: source,
      target_clean_provenance: {
        status: cleanExists ? 'candidate-pointer-found-unverified' : 'future-m4-output-required',
        clean_path: cleanPath,
        current_pointer_exists: cleanExists,
        checked_locations: cleanChecks,
        reason: cleanExists
          ? 'current pointer exists; manifest content still must be verified before M3/M4'
          : 'durable _current.json not found; approved DuckDB-first design treats this as M4 output, not M0 blocker',
      },
      readiness: baselineStatus,
      blocked_reasons: blockedReasons,
      contract_alignment_reasons: alignmentReasons,
      future_required_outputs: futureOutputs,
    });
  }
  const readyForAlignmentCount = datasets.filter((d) => d.baseline_status === 'ready-for-alignment').length;
  const contractAlignmentRequiredCount = datasets.filter((d) => d.baseline_status === 'contract-alignment-required').length;
  const blockedCount = datasets.filter((d) => d.baseline_status === 'blocked').length;
  const canContinueToM1 = readyForAlignmentCount + contractAlignmentRequiredCount > 0;
  const artifact = {
    artifact_version: 'formal-duckdb-migration/inventory/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M0-baseline-refresh',
    task_id: 'T-formal-duckdb-migration-m0-baseline-refresh',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: canContinueToM1 ? 'ready-for-alignment' : 'blocked',
    conclusion: canContinueToM1 ? 'ready-for-alignment' : 'blocked',
    duckdb: {
      availability: 'available',
      engine: 'node-duckdb via Quanttrading node_modules',
      version: versionRows[0]?.version,
      connection_mode: 'OPEN_READONLY',
    },
    external_source_db: {
      alias: 'quanttrading:data/quant.duckdb',
      observed_path: dbPath,
      exists: true,
      length_bytes: dbStat.size,
      last_write_time: dbStat.mtime.toISOString(),
      project_relative_reference_available: false,
    },
    tables: allTables,
    database_list: databaseRows.map(rowPlain),
    datasets,
    decision: {
      result: canContinueToM1 ? 'ready-for-alignment' : 'blocked',
      ready_for_alignment_count: readyForAlignmentCount,
      contract_alignment_required_count: contractAlignmentRequiredCount,
      blocked_count: blockedCount,
      reasons: canContinueToM1
        ? ['source-tables-confirmed', 'clean-provenance-will-be-generated-in-m4', 'contract-alignment-required-before-write']
        : ['no-real-source-dataset-available-for-alignment'],
    },
    next_allowed_steps: canContinueToM1
      ? ['Create M1 contract-alignment only after Claude accepts this artifact.', 'Do not create M2 until M1 accepted.']
      : ['Do not create M1; resolve blocked source access or contract-date issues first.'],
  };
  const jsonPath = path.join(outDir, `${runId}.json`);
  const mdPath = path.join(outDir, `${runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const lines = [
    `# Formal DuckDB Migration Inventory: ${runId}`,
    '',
    `- status: ${artifact.status}`,
    `- duckdb: ${artifact.duckdb.engine} ${artifact.duckdb.version || ''}`.trim(),
    `- connection: ${artifact.duckdb.connection_mode}`,
    `- source DB alias: ${artifact.external_source_db.alias}`,
    `- source DB observed path: ${dbPath}`,
    `- source DB file: ${dbStat.size} bytes`,
    `- tables found: ${allTables.length}`,
    '',
    '## Dataset Readiness',
    '',
    ...datasets.map((d) => `- ${d.dataset}: ${d.baseline_status}; source=${d.source_duckdb.status}${d.source_duckdb.row_count != null ? ` rows=${d.source_duckdb.row_count} range=${d.source_duckdb.date_range?.from || 'NA'}..${d.source_duckdb.date_range?.to || 'NA'}` : ''}; clean=${d.target_clean_provenance.status}${d.contract_alignment_reasons.length ? `; alignment=${d.contract_alignment_reasons.join(',')}` : ''}${d.blocked_reasons.length ? `; blocked=${d.blocked_reasons.join(',')}` : ''}${d.future_required_outputs.length ? `; future_outputs=${d.future_required_outputs.join(',')}` : ''}`),
    '',
    '## Decision',
    '',
    `- result: ${artifact.decision.result}`,
    `- ready_for_alignment_count: ${artifact.decision.ready_for_alignment_count}`,
    `- contract_alignment_required_count: ${artifact.decision.contract_alignment_required_count}`,
    `- blocked_count: ${artifact.decision.blocked_count}`,
    `- reasons: ${artifact.decision.reasons.join(', ')}`,
  ];
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    jsonPath,
    mdPath,
    status: artifact.status,
    ready_for_alignment_count: readyForAlignmentCount,
    contract_alignment_required_count: contractAlignmentRequiredCount,
    blocked_count: blockedCount,
  }, null, 2));
} finally {
  await client.close();
}
