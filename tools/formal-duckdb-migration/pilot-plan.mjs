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
const inventoryPath = args.inventory;
const alignmentPath = args.alignment;
const outDir = args.outDir || '.ai-coord/artifacts/formal-duckdb-migration/plan';
const runId = args.runId || `pilot-plan-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());

if (!dbPath) throw new Error('missing --db');
if (!inventoryPath) throw new Error('missing --inventory');
if (!alignmentPath) throw new Error('missing --alignment');

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
const normalizePath = (file) => file.replaceAll('\\', '/');
const toDate = (yyyyMmDd) => {
  const [year, month, day] = String(yyyyMmDd).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
const dateString = (date) => date.toISOString().slice(0, 10);
const previousFullMonthWindow = (maxDateString) => {
  const max = toDate(maxDateString);
  const start = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth() - 1, 1));
  const endExclusive = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth(), 1));
  const endInclusive = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);
  const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    start: dateString(start),
    end: dateString(endInclusive),
    end_exclusive: dateString(endExclusive),
    month,
    partition_id: `month=${month}`,
  };
};
const assertUnderWorkspace = (relativePath) => {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`target path escapes workspace: ${relativePath}`);
  }
  return normalizePath(path.relative(workspaceRoot, resolved));
};

const inventory = await readJson(inventoryPath);
const alignment = await readJson(alignmentPath);
const eligible = alignment.datasets.filter((dataset) => dataset.pilot_plan_eligible);
const preferredOrder = ['daily_basic', 'moneyflow_daily'];
const pilotDataset = preferredOrder.map((name) => eligible.find((dataset) => dataset.dataset === name)).find(Boolean) || eligible[0];
if (!pilotDataset) throw new Error('no pilot-plan-eligible dataset in contract alignment artifact');

const inventoryDataset = inventory.datasets.find((dataset) => dataset.dataset === pilotDataset.dataset);
if (!inventoryDataset) throw new Error(`inventory dataset missing: ${pilotDataset.dataset}`);

const window = previousFullMonthWindow(inventoryDataset.source_duckdb.date_range.to);
const versionId = `${runId}-${window.partition_id}`;
const stagingPath = `data/staging/formal-duckdb-migration/${pilotDataset.dataset}/${window.partition_id}/${runId}`;
const cleanManifestPath = `data/clean/${pilotDataset.dataset}/_versions/${window.partition_id}/${versionId}/manifest.json`;
const queryEntryPointer = `metadata/query-entry/${pilotDataset.dataset}.json`;

const client = await openReadonly(dbPath);
try {
  const versionRows = await client.all('SELECT version() AS version');
  const profile = rowPlain((await client.all(`
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
    FROM daily_basic
    WHERE trade_date >= ? AND trade_date < ?
  `, [window.start, window.end_exclusive]))[0]);
  const duplicate = rowPlain((await client.all(`
    SELECT COALESCE(SUM(cnt - 1), 0) AS duplicate_key_count
    FROM (
      SELECT ts_code, trade_date, COUNT(*) AS cnt
      FROM daily_basic
      WHERE trade_date >= ? AND trade_date < ?
      GROUP BY ts_code, trade_date
      HAVING COUNT(*) > 1
    )
  `, [window.start, window.end_exclusive]))[0]);
  const sourceDistribution = (await client.all(`
    SELECT CAST(source AS VARCHAR) AS source, COUNT(*) AS row_count
    FROM daily_basic
    WHERE trade_date >= ? AND trade_date < ?
    GROUP BY source
    ORDER BY row_count DESC, source
    LIMIT 20
  `, [window.start, window.end_exclusive])).map(rowPlain);

  const artifact = {
    artifact_version: 'formal-duckdb-migration/pilot-plan/v1',
    spec: 'formal-duckdb-migration',
    stage: 'M2-pilot-plan',
    task_id: 'T-formal-duckdb-migration-m2-pilot-plan',
    run_id: runId,
    created_at: new Date().toISOString(),
    agent: 'codex',
    status: 'pilot-planned',
    duckdb: {
      availability: 'available',
      engine: 'node-duckdb via Quanttrading node_modules',
      version: versionRows[0]?.version,
      connection_mode: 'OPEN_READONLY',
    },
    inputs: {
      inventory_artifact: normalizePath(inventoryPath),
      contract_alignment_artifact: normalizePath(alignmentPath),
      source_db_alias: inventory.external_source_db?.alias,
      source_db_observed_path: inventory.external_source_db?.observed_path,
    },
    pilot: {
      dataset: pilotDataset.dataset,
      reason: 'daily_basic is the first preferred pilot among pilot-plan-eligible datasets; it is a migration candidate, key-matched, smaller than moneyflow_daily, and excludes the source max-date month.',
      source_table: pilotDataset.source_table,
      logical_key: pilotDataset.canonical.logical_key,
      date_column: pilotDataset.canonical.date_column,
      partition_id: window.partition_id,
      window: {
        start: window.start,
        end: window.end,
        end_exclusive: window.end_exclusive,
        excludes_source_max_date: true,
        source_max_date: inventoryDataset.source_duckdb.date_range.to,
      },
      read_only_profile: {
        row_count: profile.row_count,
        date_range: { from: profile.min_date, to: profile.max_date },
        key_non_null: {
          ts_code: profile.non_null_ts_code,
          trade_date: profile.non_null_trade_date,
        },
        duplicate_key_count: duplicate.duplicate_key_count,
        approx_distinct_ts_code: profile.approx_distinct_ts_code,
        provenance: {
          source_distribution: sourceDistribution,
          non_null_source: profile.non_null_source,
          non_null_ingest_run_id: profile.non_null_ingest_run_id,
          approx_distinct_ingest_run_id: profile.approx_distinct_ingest_run_id,
        },
      },
    },
    target_plan: {
      workspace_root: normalizePath(workspaceRoot),
      staging_path: assertUnderWorkspace(stagingPath),
      clean_manifest_path: assertUnderWorkspace(cleanManifestPath),
      query_entry_pointer: assertUnderWorkspace(queryEntryPointer),
      clean_manifest_schema_field: 'schema_version',
      clean_manifest_schema_version: 'clean-version-manifest/v1',
      no_writes_performed: true,
    },
    future_tasks_outline: [
      {
        stage: 'M3-rollback-preparation',
        create_now: false,
        requires: ['artifact/formal-duckdb-migration/rollback', `query-entry/${pilotDataset.dataset}-read`],
        forbidden: ['source-duckdb-write', 'target-parquet-write', 'query-entry-switch'],
        outputs: ['.ai-coord/artifacts/formal-duckdb-migration/rollback/<run-id>.json', '.ai-coord/artifacts/formal-duckdb-migration/rollback/<run-id>.md'],
        approval: 'Claude accepted artifact required before M4.',
      },
      {
        stage: 'M4-staged-duckdb-to-parquet-clean-manifest',
        create_now: false,
        requires: ['duckdb', `data-staging/${pilotDataset.dataset}/${window.partition_id}`, `data-clean/${pilotDataset.dataset}/${window.partition_id}`],
        forbidden: ['source-duckdb-write', 'source-duckdb-ddl', 'source-duckdb-copy-target', 'query-entry-switch'],
        outputs: [stagingPath, cleanManifestPath],
        approval: 'Requires explicit human approval to enter M3+ before creation.',
      },
      {
        stage: 'M5-consistency-verification-quality-gate',
        create_now: false,
        requires: ['duckdb', `data-clean/${pilotDataset.dataset}/${window.partition_id}`, 'artifact/formal-duckdb-migration/consistency-verify'],
        forbidden: ['source-duckdb-write', 'query-entry-switch'],
        outputs: ['.ai-coord/artifacts/formal-duckdb-migration/consistency-verify/<run-id>.json', '.ai-coord/artifacts/formal-duckdb-migration/quality-gate/<run-id>.json'],
        approval: 'Claude accepted verification required before switch proposal.',
      },
      {
        stage: 'M6-switch-proposal-rollback-dry-run',
        create_now: false,
        requires: [`query-entry/${pilotDataset.dataset}`, 'artifact/formal-duckdb-migration/switch-proposal'],
        forbidden: ['production-default-change', 'drop-source-table', 'archive-source-table'],
        outputs: ['.ai-coord/artifacts/formal-duckdb-migration/switch-proposal/<run-id>.json', '.ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run/<run-id>.json'],
        approval: 'Separate human approval required before any production query-entry switch.',
      },
    ],
    decision: {
      result: 'pilot-planned-stop-before-m3',
      next_allowed_steps: ['Stop after Claude accepts T2. Human owner must decide whether to approve entering M3+.'],
    },
  };

  if (artifact.pilot.read_only_profile.row_count <= 0) {
    artifact.status = 'blocked';
    artifact.decision.result = 'blocked-empty-pilot-window';
    artifact.decision.next_allowed_steps = ['Choose a different closed pilot window after review.'];
  }
  if (artifact.pilot.read_only_profile.duplicate_key_count !== 0) {
    artifact.status = 'blocked';
    artifact.decision.result = 'blocked-duplicate-keys-in-pilot-window';
    artifact.decision.next_allowed_steps = ['Resolve duplicate keys or choose another pilot window before M3+.'];
  }

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${runId}.json`);
  const mdPath = path.join(outDir, `${runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const lines = [
    `# Formal DuckDB Migration Pilot Plan: ${runId}`,
    '',
    `- status: ${artifact.status}`,
    `- duckdb: ${artifact.duckdb.engine} ${artifact.duckdb.version || ''}`.trim(),
    `- connection: ${artifact.duckdb.connection_mode}`,
    `- pilot: ${artifact.pilot.dataset} ${artifact.pilot.partition_id}`,
    `- window: ${artifact.pilot.window.start}..${artifact.pilot.window.end}`,
    `- rows: ${artifact.pilot.read_only_profile.row_count}`,
    `- duplicate_key_count: ${artifact.pilot.read_only_profile.duplicate_key_count}`,
    '',
    '## Target Plan',
    '',
    `- staging_path: ${artifact.target_plan.staging_path}`,
    `- clean_manifest_path: ${artifact.target_plan.clean_manifest_path}`,
    `- schema_version: ${artifact.target_plan.clean_manifest_schema_version}`,
    `- query_entry_pointer: ${artifact.target_plan.query_entry_pointer}`,
    '',
    '## Future Tasks',
    '',
    ...artifact.future_tasks_outline.map((task) => `- ${task.stage}: create_now=${task.create_now}; approval=${task.approval}`),
    '',
    '## Stop Rule',
    '',
    '- Do not create M3+ tasks after this artifact. Wait for Claude review and human owner decision.',
  ];
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    jsonPath,
    mdPath,
    status: artifact.status,
    pilot: artifact.pilot.dataset,
    partition_id: artifact.pilot.partition_id,
    row_count: artifact.pilot.read_only_profile.row_count,
    duplicate_key_count: artifact.pilot.read_only_profile.duplicate_key_count,
  }, null, 2));
} finally {
  await client.close();
}
