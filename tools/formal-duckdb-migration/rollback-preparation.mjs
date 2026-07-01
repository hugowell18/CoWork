#!/usr/bin/env node
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
const planPath = args.plan;
const outDir = args.outDir || '.ai-coord/artifacts/formal-duckdb-migration/rollback';
const runId = args.runId || `rollback-preparation-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());
const quantRoot = path.resolve(args.quantRoot || 'C:/Workspace/Quanttrading/Quanttrading');

if (!planPath) throw new Error('missing --plan');

const normalizePath = (file) => file.replaceAll('\\', '/');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const fileState = async (relativePath) => {
  const resolved = path.resolve(workspaceRoot, relativePath);
  try {
    const stat = await fs.stat(resolved);
    const content = stat.isFile() ? await fs.readFile(resolved, 'utf8') : null;
    return {
      state: 'present',
      relative_path: normalizePath(path.relative(workspaceRoot, resolved)),
      absolute_path: normalizePath(resolved),
      size_bytes: stat.size,
      last_write_time: stat.mtime.toISOString(),
      parsed_json: content ? JSON.parse(content) : null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      state: 'absent',
      relative_path: normalizePath(relativePath),
      absolute_path: normalizePath(resolved),
    };
  }
};

const assertUnderRoot = (label, relativePath, root) => {
  const resolved = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const inside = resolved === root || resolved.startsWith(rootWithSep);
  return {
    label,
    relative_path: normalizePath(relativePath),
    absolute_path: normalizePath(resolved),
    required_root: normalizePath(root),
    inside_required_root: inside,
  };
};

const assertNotUnderRoot = (label, absolutePath, root) => {
  const resolved = path.resolve(absolutePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const outside = resolved !== root && !resolved.startsWith(rootWithSep);
  return {
    label,
    absolute_path: normalizePath(resolved),
    forbidden_root: normalizePath(root),
    outside_forbidden_root: outside,
  };
};

const requiredPlan = await readJson(planPath);
const dataset = requiredPlan?.pilot?.dataset;
const partitionId = requiredPlan?.pilot?.partition_id;
const targetPlan = requiredPlan?.target_plan ?? {};
if (dataset !== 'daily_basic') throw new Error(`unexpected pilot dataset: ${dataset}`);
if (partitionId !== 'month=2026-05') throw new Error(`unexpected pilot partition: ${partitionId}`);

const stagingPath = targetPlan.staging_path;
const cleanManifestPath = targetPlan.clean_manifest_path;
const cleanVersionDir = normalizePath(path.dirname(cleanManifestPath));
const queryEntryPointer = targetPlan.query_entry_pointer;
if (!stagingPath) throw new Error('plan missing target_plan.staging_path');
if (!cleanManifestPath) throw new Error('plan missing target_plan.clean_manifest_path');
if (!queryEntryPointer) throw new Error('plan missing target_plan.query_entry_pointer');

const cleanCurrentPointer = `data/clean/${dataset}/_current.json`;
const pathChecks = [
  assertUnderRoot('staging_path', stagingPath, workspaceRoot),
  assertUnderRoot('clean_version_dir', cleanVersionDir, workspaceRoot),
  assertUnderRoot('clean_manifest_path', cleanManifestPath, workspaceRoot),
  assertUnderRoot('query_entry_pointer', queryEntryPointer, workspaceRoot),
  assertUnderRoot('clean_current_pointer', cleanCurrentPointer, workspaceRoot),
].map((item) => ({
  ...item,
  source_repo_check: assertNotUnderRoot(item.label, item.absolute_path, quantRoot),
}));

const failedPathCheck = pathChecks.find((item) => !item.inside_required_root || !item.source_repo_check.outside_forbidden_root);
if (failedPathCheck) {
  throw new Error(`target path failed boundary check: ${failedPathCheck.label}`);
}

const queryEntryState = await fileState(queryEntryPointer);
const cleanCurrentState = await fileState(cleanCurrentPointer);

const artifact = {
  artifact_version: 'formal-duckdb-migration/rollback-preparation/v1',
  spec: 'formal-duckdb-migration',
  stage: 'M3-rollback-preparation',
  task_id: 'T-formal-duckdb-migration-m3-rollback-preparation',
  run_id: runId,
  created_at: new Date().toISOString(),
  agent: 'codex',
  status: 'rollback-prepared',
  inputs: {
    pilot_plan_artifact: normalizePath(planPath),
    tasks_revision: 4,
    design_revision: 4,
    requirements_revision: 3,
  },
  pilot: {
    dataset,
    source_table: requiredPlan.pilot.source_table,
    partition_id: partitionId,
    window: requiredPlan.pilot.window,
    expected_row_count: requiredPlan.pilot.read_only_profile?.row_count,
    expected_duplicate_key_count: requiredPlan.pilot.read_only_profile?.duplicate_key_count,
  },
  old_state: {
    query_entry_pointer: queryEntryState,
    clean_current_pointer: cleanCurrentState,
  },
  future_m4_targets: {
    staging_path: normalizePath(stagingPath),
    clean_version_dir: cleanVersionDir,
    clean_manifest_path: normalizePath(cleanManifestPath),
    schema_version: targetPlan.clean_manifest_schema_version,
    query_entry_pointer: normalizePath(queryEntryPointer),
    clean_current_pointer: normalizePath(cleanCurrentPointer),
  },
  boundary_checks: {
    workspace_root: normalizePath(workspaceRoot),
    forbidden_source_root: normalizePath(quantRoot),
    targets: pathChecks,
    result: 'passed',
  },
  cleanup_strategy: {
    m4_failed_before_manifest: 'Remove or quarantine the new staging directory and clean version directory. No _current.json or query-entry pointer exists in scope for this task.',
    m4_failed_after_manifest_quality_pending: 'Keep the manifest only if needed for audit, otherwise quarantine the full clean version directory. Do not publish _current.json and do not modify metadata/query-entry/daily_basic.json.',
    m5_failed: 'Record failed verification artifacts and leave or set the clean manifest status to quality-failed/quality-pending. Keep target files for audit until root cause is resolved; do not publish _current.json or query-entry pointer.',
    m6_blocked_or_failed: 'Discard artifact-local candidate pointer files. Production metadata/query-entry/daily_basic.json remains untouched.',
  },
  recovery_boundaries: {
    m4: {
      allowed_cleanup_scope: [
        normalizePath(stagingPath),
        cleanVersionDir,
      ],
      forbidden_cleanup_scope: [
        normalizePath(queryEntryPointer),
        normalizePath(cleanCurrentPointer),
        'C:/Workspace/Quanttrading/Quanttrading/data/quant.duckdb',
      ],
      rollback_condition: 'Any partial or failed staged target write.',
    },
    m5: {
      allowed_updates: ['existing clean version manifest status/checksum/quality fields only'],
      rollback_condition: 'Any source-vs-target mismatch, duplicate key mismatch, checksum mismatch, numeric/null distribution mismatch, or manifest inconsistency.',
    },
    m6: {
      allowed_scope: '.ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run candidate pointer files only',
      rollback_condition: 'Candidate pointer cannot be restored from new value to old value without touching production query-entry.',
    },
  },
  m6_rollback_dry_run_acceptance: [
    'Use only artifact-local candidate pointer files under .ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run.',
    'Record old query-entry pointer state as absent or present from this M3 artifact.',
    'Simulate candidate pointer replacement from old value to proposed value and back to old value.',
    'Prove production metadata/query-entry/daily_basic.json was not created or modified.',
    'If existing adapters cannot guarantee deterministic dataset/window mixed routing, mark the switch proposal blocked or require a whole-dataset switch decision.',
  ],
  write_statement: {
    source_duckdb_opened: false,
    source_duckdb_write: false,
    target_parquet_write: false,
    data_clean_write: false,
    clean_current_pointer_write: false,
    query_entry_pointer_write: false,
    query_entry_switch: false,
    created_m4_or_later_tasks: false,
  },
  decision: {
    result: 'rollback-prepared-awaiting-claude-review',
    next_allowed_step_after_claude_acceptance: 'Create T-formal-duckdb-migration-m4-staged-clean-generation only.',
  },
};

const renderMarkdown = (item) => `# M3 rollback preparation

- Status: ${item.status}
- Dataset/window: ${item.pilot.dataset} / ${item.pilot.partition_id}
- Pilot plan: ${item.inputs.pilot_plan_artifact}
- Old query-entry pointer: ${item.old_state.query_entry_pointer.state}
- Old clean _current pointer: ${item.old_state.clean_current_pointer.state}
- Staging target: ${item.future_m4_targets.staging_path}
- Clean version dir: ${item.future_m4_targets.clean_version_dir}
- Clean manifest: ${item.future_m4_targets.clean_manifest_path}
- Boundary checks: ${item.boundary_checks.result}

## No-write statement

- Source DuckDB opened: ${item.write_statement.source_duckdb_opened}
- Source DuckDB write: ${item.write_statement.source_duckdb_write}
- Target Parquet write: ${item.write_statement.target_parquet_write}
- Data clean write: ${item.write_statement.data_clean_write}
- Clean _current pointer write: ${item.write_statement.clean_current_pointer_write}
- Query-entry pointer write: ${item.write_statement.query_entry_pointer_write}
- Query-entry switch: ${item.write_statement.query_entry_switch}
- M4+ task files created: ${item.write_statement.created_m4_or_later_tasks}

## Recovery boundaries

- M4 cleanup scope: ${item.recovery_boundaries.m4.allowed_cleanup_scope.join(', ')}
- M5 allowed update: ${item.recovery_boundaries.m5.allowed_updates.join(', ')}
- M6 allowed scope: ${item.recovery_boundaries.m6.allowed_scope}

## M6 rollback dry-run acceptance

${item.m6_rollback_dry_run_acceptance.map((line) => `- ${line}`).join('\n')}
`;

await fs.mkdir(outDir, { recursive: true });
const jsonPath = path.join(outDir, `${runId}.json`);
const mdPath = path.join(outDir, `${runId}.md`);
await fs.writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
await fs.writeFile(mdPath, renderMarkdown(artifact), 'utf8');

console.log(JSON.stringify({
  status: artifact.status,
  json: normalizePath(jsonPath),
  md: normalizePath(mdPath),
  old_query_entry_pointer: queryEntryState.state,
  old_clean_current_pointer: cleanCurrentState.state,
  boundary_checks: artifact.boundary_checks.result,
}, null, 2));
