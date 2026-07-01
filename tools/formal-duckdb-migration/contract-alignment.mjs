#!/usr/bin/env node
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
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
const quantRoot = args.quantRoot || 'C:/Workspace/Quanttrading/Quanttrading';
const contractsDir = args.contractsDir || 'metadata/dataset-contracts';
const inventoryPath = args.inventory;
const outDir = args.outDir || '.ai-coord/artifacts/formal-duckdb-migration/contract-alignment';
const runId = args.runId || `contract-alignment-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!dbPath) throw new Error('missing --db');
if (!inventoryPath) throw new Error('missing --inventory');

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
const toPlain = (value) => typeof value === 'bigint' ? Number(value) : value;
const rowPlain = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, toPlain(v)]));
const safeIdent = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
};
const normalizePath = (file) => file.replaceAll('\\', '/');
const isNumericType = (type) => /(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|INTEGER|BIGINT|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT)/i.test(type);
const isTemporalType = (type) => /(DATE|TIME|TIMESTAMP)/i.test(type);
const PROVENANCE_COLUMNS = ['source', 'source_detail', 'ingest_run_id', 'quality_status', 'raw_count', 'updated_at'];

const loadContracts = async () => {
  const entries = await fs.readdir(contractsDir, { withFileTypes: true });
  const out = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'schema.json') continue;
    const contract = await readJson(path.join(contractsDir, entry.name));
    out.set(contract.dataset, { path: `${contractsDir.replaceAll('\\', '/')}/${entry.name}`, contract });
  }
  return out;
};

const columnProfiles = async (client, tableName, columns) => {
  const table = safeIdent(tableName);
  const expressions = ['COUNT(*) AS __row_count'];
  for (const column of columns) {
    const name = safeIdent(column.column_name);
    const prefix = name.replace(/[^A-Za-z0-9_]/g, '_');
    expressions.push(`COUNT(${name}) AS ${prefix}__non_null`);
    expressions.push(`CAST(MIN(${name}) AS VARCHAR) AS ${prefix}__min`);
    expressions.push(`CAST(MAX(${name}) AS VARCHAR) AS ${prefix}__max`);
  }
  const row = rowPlain((await client.all(`SELECT ${expressions.join(', ')} FROM ${table}`))[0]);
  const profiles = {};
  for (const column of columns) {
    const prefix = column.column_name.replace(/[^A-Za-z0-9_]/g, '_');
    profiles[column.column_name] = {
      non_null_count: row[`${prefix}__non_null`],
      null_count: row.__row_count - row[`${prefix}__non_null`],
      min_value: row[`${prefix}__min`],
      max_value: row[`${prefix}__max`],
    };
  }
  return profiles;
};

const classifyColumn = (name, contract) => {
  if ((contract.logical_key || []).includes(name)) return 'logical-key';
  if (contract.date_column === name) return 'date';
  if ((contract.sort_order || []).includes(name)) return 'sort';
  if (PROVENANCE_COLUMNS.includes(name)) return 'provenance';
  return 'data';
};

const defaultNormalization = (columns, contract) => {
  const numericColumns = columns.filter((c) => isNumericType(c.data_type)).map((c) => c.column_name);
  const temporalColumns = columns.filter((c) => isTemporalType(c.data_type)).map((c) => c.column_name);
  return {
    numeric: {
      columns: numericColumns,
      rule: 'preserve DuckDB type when possible; compare DOUBLE/FLOAT with explicit normalized numeric rendering in M5, integers exact',
      double_checksum_rendering: 'round-trip DuckDB cast to DOUBLE with null sentinel before order-independent checksum',
    },
    temporal: {
      columns: temporalColumns,
      date_column: contract.date_column,
      rule: 'preserve DATE/TIMESTAMP semantics; window predicates use contract date_column; nulls remain null',
    },
    nulls: {
      rule: 'nulls are not coerced to empty strings or zero; M5 compares per-column null_count and checksum null sentinel',
    },
    checksum: {
      rule: 'order-independent checksum over logical key plus canonical non-volatile columns after type-specific normalization',
    },
  };
};

const alignmentForDataset = async (client, inventoryDataset, contractEntry) => {
  const contract = contractEntry.contract;
  const source = inventoryDataset.source_duckdb;
  if (source.status !== 'confirmed') {
    return {
      dataset: inventoryDataset.dataset,
      alignment_status: 'blocked',
      pilot_plan_eligible: false,
      blocked_reasons: ['source-not-confirmed'],
    };
  }

  const sourceColumns = source.columns;
  const sourceColumnNames = sourceColumns.map((c) => c.column_name);
  const sourceColumnSet = new Set(sourceColumnNames.map((c) => c.toLowerCase()));
  const profiles = await columnProfiles(client, source.table_or_view, sourceColumns);
  const missingContractKeys = (contract.logical_key || []).filter((c) => !sourceColumnSet.has(c.toLowerCase()));
  const sourceToTarget = sourceColumns.map((column) => ({
    source_column: column.column_name,
    target_column: column.column_name,
    duckdb_type: column.data_type,
    role: classifyColumn(column.column_name, contract),
    profile: profiles[column.column_name],
  }));

  const provenancePresent = PROVENANCE_COLUMNS.filter((column) => sourceColumnSet.has(column.toLowerCase()));
  const provenanceStrategy = {
    present: provenancePresent,
    carried_to_parquet: provenancePresent,
    profiled_in_manifest: provenancePresent,
    quality_gate: provenancePresent.includes('quality_status')
      ? 'M5 fails on non-passing quality_status unless a separate human-approved gap acceptance exists'
      : 'No quality_status source column; M5 records absence in manifest profile',
    no_fabricated_ingest_provenance: true,
  };

  const recommendedContractDelta = {};
  const compatibilityAliases = [];
  let alignmentStatus = 'pilot-plan-eligible';
  let pilotPlanEligible = true;
  let writeReadiness = 'not-write-authorized-in-m1';
  const alignmentReasons = [];

  if (inventoryDataset.dataset === 'bar_minute') {
    alignmentStatus = 'contract-update-required';
    pilotPlanEligible = false;
    alignmentReasons.push('old-contract-logical-key-trade_time-missing-in-source');
    recommendedContractDelta.logical_key = {
      from: contract.logical_key,
      to: ['ts_code', 'ts'],
    };
    recommendedContractDelta.sort_order = {
      from: contract.sort_order,
      to: ['ts_code', 'ts'],
    };
    compatibilityAliases.push({
      alias: 'trade_time',
      expression: 'ts',
      scope: 'adapter/candidate-view-only',
      note: 'Compatibility alias only; do not treat trade_time as a source DuckDB fact.',
    });
    sourceToTarget.push({
      source_column: 'ts',
      target_column: 'trade_time',
      duckdb_type: 'TIMESTAMP',
      role: 'compatibility-alias',
      write_policy: 'adapter/candidate-view-only',
    });
  } else if (missingContractKeys.length) {
    alignmentStatus = 'contract-update-required';
    pilotPlanEligible = false;
    alignmentReasons.push('contract-logical-key-not-fully-found-in-source');
  }
  if (pilotPlanEligible && contract.migration?.candidate === false) {
    alignmentStatus = 'aligned-not-migration-candidate';
    pilotPlanEligible = false;
    alignmentReasons.push('contract-migration-candidate-false');
  }

  return {
    dataset: inventoryDataset.dataset,
    contract_path: contractEntry.path,
    migration_candidate: Boolean(contract.migration?.candidate),
    migration_candidate_reason: contract.migration?.candidate_reason,
    source_table: source.table_or_view,
    source_schema_hash: source.schema_hash,
    source_row_count: source.row_count,
    source_date_range: source.date_range,
    baseline_status: inventoryDataset.baseline_status,
    alignment_status: alignmentStatus,
    pilot_plan_eligible: pilotPlanEligible,
    write_readiness: writeReadiness,
    alignment_reasons: alignmentReasons,
    canonical: {
      columns: sourceColumnNames,
      logical_key: inventoryDataset.dataset === 'bar_minute' ? ['ts_code', 'ts'] : contract.logical_key,
      partition_key: contract.partition?.column,
      partition_type: contract.partition?.type,
      sort_key: inventoryDataset.dataset === 'bar_minute' ? ['ts_code', 'ts'] : contract.sort_order,
      date_column: contract.date_column,
    },
    source_to_target_mapping: sourceToTarget,
    compatibility_aliases: compatibilityAliases,
    recommended_contract_delta: recommendedContractDelta,
    normalization: defaultNormalization(sourceColumns, {
      ...contract,
      logical_key: inventoryDataset.dataset === 'bar_minute' ? ['ts_code', 'ts'] : contract.logical_key,
      sort_order: inventoryDataset.dataset === 'bar_minute' ? ['ts_code', 'ts'] : contract.sort_order,
    }),
    provenance_strategy: provenanceStrategy,
    future_clean_manifest: {
      required_in_stage: 'M4',
      schema_version_field: 'schema_version',
      schema_version: 'clean-version-manifest/v1',
      path_layout: 'data/clean/<dataset>/_versions/<partition-id>/<version-id>/manifest.json',
    },
  };
};

await fs.mkdir(outDir, { recursive: true });
const inventory = await readJson(inventoryPath);
const contracts = await loadContracts();
const client = await openReadonly(dbPath);
try {
  const versionRows = await client.all('SELECT version() AS version');
  const datasets = [];
  for (const inventoryDataset of inventory.datasets) {
    const contractEntry = contracts.get(inventoryDataset.dataset);
    if (!contractEntry) {
      datasets.push({
        dataset: inventoryDataset.dataset,
        alignment_status: 'blocked',
        pilot_plan_eligible: false,
        blocked_reasons: ['contract-not-found'],
      });
      continue;
    }
    datasets.push(await alignmentForDataset(client, inventoryDataset, contractEntry));
  }

  const pilotEligible = datasets.filter((d) => d.pilot_plan_eligible);
  const artifact = {
    artifact_version: 'formal-duckdb-migration/contract-alignment/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M1-contract-alignment',
    task_id: 'T-formal-duckdb-migration-m1-contract-alignment',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: pilotEligible.length ? 'ready-for-pilot-plan' : 'blocked',
    duckdb: {
      availability: 'available',
      engine: 'node-duckdb via Quanttrading node_modules',
      version: versionRows[0]?.version,
      connection_mode: 'OPEN_READONLY',
    },
    inputs: {
      inventory_artifact: normalizePath(inventoryPath),
      source_db_alias: inventory.external_source_db?.alias,
      source_db_observed_path: inventory.external_source_db?.observed_path,
    },
    datasets,
    decision: {
      result: pilotEligible.length ? 'ready-for-pilot-plan' : 'blocked',
      pilot_plan_eligible_datasets: pilotEligible.map((d) => d.dataset),
      blocked_or_deferred_datasets: datasets.filter((d) => !d.pilot_plan_eligible).map((d) => ({
        dataset: d.dataset,
        alignment_status: d.alignment_status,
        reasons: d.alignment_reasons || d.blocked_reasons || [],
      })),
      next_allowed_steps: pilotEligible.length
        ? ['After Claude accepts this artifact, create T2 pilot plan only. Do not create M3+ tasks.']
        : ['Do not create T2 until at least one dataset is pilot-plan-eligible.'],
    },
  };

  const jsonPath = path.join(outDir, `${runId}.json`);
  const mdPath = path.join(outDir, `${runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const lines = [
    `# Formal DuckDB Migration Contract Alignment: ${runId}`,
    '',
    `- status: ${artifact.status}`,
    `- duckdb: ${artifact.duckdb.engine} ${artifact.duckdb.version || ''}`.trim(),
    `- connection: ${artifact.duckdb.connection_mode}`,
    `- inventory: ${artifact.inputs.inventory_artifact}`,
    '',
    '## Dataset Alignment',
    '',
    ...datasets.map((d) => `- ${d.dataset}: ${d.alignment_status}; pilot_plan_eligible=${d.pilot_plan_eligible}; logical_key=${(d.canonical?.logical_key || []).join(',')}${d.alignment_reasons?.length ? `; reasons=${d.alignment_reasons.join(',')}` : ''}`),
    '',
    '## Pilot Eligible',
    '',
    ...pilotEligible.map((d) => `- ${d.dataset}`),
    '',
    '## Notes',
    '',
    '- No metadata/dataset-contracts files were modified.',
    '- Source DuckDB was opened with OPEN_READONLY only.',
    '- No Parquet, clean pointer, query-entry pointer, drop, archive, or task bulk creation was performed.',
  ];
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    jsonPath,
    mdPath,
    status: artifact.status,
    pilot_plan_eligible_datasets: artifact.decision.pilot_plan_eligible_datasets,
  }, null, 2));
} finally {
  await client.close();
}
