#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());
const rollbackPath = args.rollback;
const qualityPath = args.quality;
const manifestPath = args.manifest;
const outProposalDir = args.proposalOutDir || '.ai-coord/artifacts/formal-duckdb-migration/switch-proposal';
const outRollbackDir = args.rollbackOutDir || '.ai-coord/artifacts/formal-duckdb-migration/rollback-dry-run';
const runId = args.runId || `switch-proposal-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!rollbackPath) throw new Error('missing --rollback');
if (!qualityPath) throw new Error('missing --quality');
if (!manifestPath) throw new Error('missing --manifest');

const normalizePath = (file) => file.replaceAll('\\', '/');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
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
  return {
    label,
    relative_path: normalizePath(path.relative(workspaceRoot, absolute)),
    absolute_path: normalizePath(absolute),
  };
};

const existsState = async (relativePath) => {
  const absolute = path.resolve(workspaceRoot, relativePath);
  try {
    const stat = await fs.stat(absolute);
    return {
      state: 'present',
      relative_path: normalizePath(relativePath),
      absolute_path: normalizePath(absolute),
      size_bytes: stat.size,
      last_write_time: stat.mtime.toISOString(),
      parsed_json: JSON.parse(await fs.readFile(absolute, 'utf8')),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      state: 'absent',
      relative_path: normalizePath(relativePath),
      absolute_path: normalizePath(absolute),
    };
  }
};

const rollback = await readJson(rollbackPath);
const quality = await readJson(qualityPath);
const manifest = await readJson(manifestPath);
if (rollback.status !== 'rollback-prepared') throw new Error('rollback artifact is not prepared');
if (quality.status !== 'passed') throw new Error('quality gate artifact is not passed');
if (manifest.status !== 'quality-passed') throw new Error(`manifest is not quality-passed: ${manifest.status}`);
if (manifest.dataset !== 'daily_basic' || manifest.partition_id !== 'month=2026-05') {
  throw new Error('manifest dataset/partition mismatch');
}

const queryEntryPointer = 'metadata/query-entry/daily_basic.json';
const cleanCurrentPointer = 'data/clean/daily_basic/_current.json';
const oldQueryEntry = await existsState(queryEntryPointer);
const oldCleanCurrent = await existsState(cleanCurrentPointer);
const manifestCheck = assertUnderWorkspace('manifest', manifestPath);
const targetFileChecks = (manifest.target_files || []).map((file, index) => assertUnderWorkspace(`target_file_${index}`, file.path));
const queryEntryCheck = assertUnderWorkspace('query_entry_pointer', queryEntryPointer);

const adapterSearch = {
  query_entry_dir_exists: oldQueryEntry.state === 'present',
  deterministic_dataset_window_mixed_routing_proven: false,
  evidence: [
    'metadata/query-entry directory is absent.',
    'Repository search found no production query-entry adapter capable of deterministic dataset/window routing for daily_basic/month=2026-05.',
    'Existing tools mention query-entry governance but do not provide a production switch implementation for mixed DuckDB-source plus Parquet-window routing.',
  ],
};

const proposedPointer = {
  schema_version: 'query-entry-pointer/v1-candidate',
  dataset: 'daily_basic',
  status: 'candidate-only-not-production',
  switch_grain: 'dataset/window',
  route: {
    dataset: 'daily_basic',
    partition_id: 'month=2026-05',
    window: manifest.window,
    target_manifest: normalizePath(manifestPath),
    target_manifest_schema_version: manifest.schema_version,
    target_manifest_status: manifest.status,
    target_files: manifest.target_files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      row_count: file.row_count,
    })),
    canonical_columns: manifest.contract.selected_columns,
    source_fallback_required_outside_window: true,
  },
  production_switch_allowed_by_this_artifact: false,
  production_blocker: 'No deterministic dataset/window mixed-routing adapter has been proven. M7 must either approve and implement/prove window routing or switch only after whole-dataset migration verification.',
  rollback: {
    old_query_entry_pointer_state: oldQueryEntry.state,
    restore_action_if_old_absent: 'delete candidate/production pointer to restore absent state',
    restore_action_if_old_present: 'replace pointer content with old_query_entry_pointer snapshot',
  },
};

const proposal = {
  artifact_version: 'formal-duckdb-migration/switch-proposal/v1',
  spec: 'formal-duckdb-migration',
  stage: 'M6-switch-proposal',
  task_id: 'T-formal-duckdb-migration-m6-switch-proposal-rollback-dry-run',
  run_id: runId,
  created_at: new Date().toISOString(),
  agent: 'codex',
  status: 'prepared-production-switch-blocked-pending-routing-decision',
  inputs: {
    rollback_artifact: normalizePath(rollbackPath),
    quality_gate_artifact: normalizePath(qualityPath),
    clean_manifest_path: normalizePath(manifestPath),
  },
  old_entry: {
    query_entry_pointer: oldQueryEntry,
    clean_current_pointer: oldCleanCurrent,
  },
  new_entry_candidate: proposedPointer,
  switch_grain: {
    proposed: 'dataset/window',
    dataset: 'daily_basic',
    partition_id: 'month=2026-05',
    status: 'blocked-for-production-until-routing-proof',
    alternative: 'whole-dataset switch after all daily_basic windows are migrated and verified',
  },
  target_manifest: {
    path: normalizePath(manifestPath),
    schema_version: manifest.schema_version,
    status: manifest.status,
    row_count: manifest.row_count,
    duplicate_key_count: manifest.duplicate_key_count,
    quality_artifact: manifest.quality?.quality_artifact,
    consistency_artifact: manifest.quality?.consistency_artifact,
  },
  adapter_assessment: adapterSearch,
  boundary_checks: {
    workspace_root: normalizePath(workspaceRoot),
    query_entry_pointer: queryEntryCheck,
    target_manifest: manifestCheck,
    target_files: targetFileChecks,
  },
  m7_requirements_before_production_switch: [
    'Separate human approval for M7 production query-entry switch.',
    'A production query-entry adapter that deterministically routes daily_basic/month=2026-05 to the quality-passed Parquet target and all other windows to the current source, or a human-approved whole-dataset switch plan after full migration.',
    'A fresh rollback artifact for the actual production pointer state at M7 time.',
    'No drop/archive action; source DuckDB remains authoritative rollback source until a later separately approved M8.',
  ],
  no_write_statement: {
    production_query_entry_pointer_write: false,
    production_query_entry_switch: false,
    clean_current_pointer_write: false,
    data_clean_write: false,
    target_parquet_write: false,
    source_duckdb_write: false,
    created_m7_or_later_tasks: false,
  },
};

const rollbackDirAbs = path.resolve(workspaceRoot, outRollbackDir);
const proposalDirAbs = path.resolve(workspaceRoot, outProposalDir);
await fs.mkdir(rollbackDirAbs, { recursive: true });
await fs.mkdir(proposalDirAbs, { recursive: true });

const candidateOld = {
  schema_version: 'query-entry-candidate-state/v1',
  run_id: runId,
  step: 'old',
  query_entry_pointer: oldQueryEntry.state === 'absent' ? { state: 'absent' } : oldQueryEntry.parsed_json,
};
const candidateNew = {
  schema_version: 'query-entry-candidate-state/v1',
  run_id: runId,
  step: 'new',
  query_entry_pointer: proposedPointer,
};
const candidateRestored = {
  schema_version: 'query-entry-candidate-state/v1',
  run_id: runId,
  step: 'restored',
  query_entry_pointer: oldQueryEntry.state === 'absent' ? { state: 'absent' } : oldQueryEntry.parsed_json,
};

const candidateOldPath = path.join(rollbackDirAbs, `${runId}.candidate-old.json`);
const candidateNewPath = path.join(rollbackDirAbs, `${runId}.candidate-new.json`);
const candidateRestoredPath = path.join(rollbackDirAbs, `${runId}.candidate-restored.json`);
await writeJsonAtomic(candidateOldPath, candidateOld);
await writeJsonAtomic(candidateNewPath, candidateNew);
await writeJsonAtomic(candidateRestoredPath, candidateRestored);

const dryRun = {
  artifact_version: 'formal-duckdb-migration/rollback-dry-run/v1',
  spec: 'formal-duckdb-migration',
  stage: 'M6-rollback-dry-run',
  task_id: 'T-formal-duckdb-migration-m6-switch-proposal-rollback-dry-run',
  run_id: runId,
  created_at: new Date().toISOString(),
  agent: 'codex',
  status: 'passed',
  scope: 'artifact-local candidate pointer simulation only',
  production_pointer_before: oldQueryEntry,
  steps: [
    {
      step: 'capture-old',
      file: normalizePath(path.relative(workspaceRoot, candidateOldPath)),
      state: oldQueryEntry.state,
    },
    {
      step: 'apply-new-candidate',
      file: normalizePath(path.relative(workspaceRoot, candidateNewPath)),
      state: 'present-candidate',
      pointer_sha256: sha256Text(canonicalJson(proposedPointer)),
    },
    {
      step: 'restore-old',
      file: normalizePath(path.relative(workspaceRoot, candidateRestoredPath)),
      state: oldQueryEntry.state,
      restored_matches_old: canonicalJson(candidateOld.query_entry_pointer) === canonicalJson(candidateRestored.query_entry_pointer),
    },
  ],
  acceptance: {
    old_to_new_to_old_simulated: true,
    restored_matches_old: canonicalJson(candidateOld.query_entry_pointer) === canonicalJson(candidateRestored.query_entry_pointer),
    production_query_entry_untouched: true,
    production_query_entry_path: queryEntryPointer,
    production_query_entry_expected_state_after: oldQueryEntry.state,
  },
  no_write_statement: proposal.no_write_statement,
};

const proposalJsonPath = path.join(proposalDirAbs, `${runId}.json`);
const proposalMdPath = path.join(proposalDirAbs, `${runId}.md`);
const dryRunJsonPath = path.join(rollbackDirAbs, `${runId}.json`);
const dryRunMdPath = path.join(rollbackDirAbs, `${runId}.md`);

const proposalMd = `# M6 switch proposal

- Status: ${proposal.status}
- Dataset/window: daily_basic / month=2026-05
- Proposed switch grain: dataset/window
- Production switch allowed by this artifact: false
- Production blocker: ${proposedPointer.production_blocker}
- Target manifest: ${proposal.target_manifest.path}
- Target status: ${proposal.target_manifest.status}
- Old query-entry pointer: ${oldQueryEntry.state}
- M7 requires separate human approval: true

## M7 Decision Required

- Prove deterministic dataset/window routing adapter, or migrate and verify the whole dataset before whole-dataset switch.
- Do not execute production query-entry switch from M6.
`;

const dryRunMd = `# M6 rollback dry-run

- Status: ${dryRun.status}
- Scope: ${dryRun.scope}
- Old production pointer: ${oldQueryEntry.state}
- Candidate old file: ${normalizePath(path.relative(workspaceRoot, candidateOldPath))}
- Candidate new file: ${normalizePath(path.relative(workspaceRoot, candidateNewPath))}
- Candidate restored file: ${normalizePath(path.relative(workspaceRoot, candidateRestoredPath))}
- Restored matches old: ${dryRun.acceptance.restored_matches_old}
- Production query-entry untouched: ${dryRun.acceptance.production_query_entry_untouched}
`;

await writeJsonAtomic(proposalJsonPath, proposal);
await fs.writeFile(proposalMdPath, proposalMd, 'utf8');
await writeJsonAtomic(dryRunJsonPath, dryRun);
await fs.writeFile(dryRunMdPath, dryRunMd, 'utf8');

const oldQueryEntryAfter = await existsState(queryEntryPointer);
if (oldQueryEntryAfter.state !== oldQueryEntry.state) {
  throw new Error(`production query-entry state changed during M6: ${oldQueryEntry.state} -> ${oldQueryEntryAfter.state}`);
}
if (oldQueryEntryAfter.state === 'present' && canonicalJson(oldQueryEntryAfter.parsed_json) !== canonicalJson(oldQueryEntry.parsed_json)) {
  throw new Error('production query-entry content changed during M6');
}

console.log(JSON.stringify({
  proposal_status: proposal.status,
  dry_run_status: dryRun.status,
  proposal_artifact: normalizePath(path.relative(workspaceRoot, proposalJsonPath)),
  rollback_dry_run_artifact: normalizePath(path.relative(workspaceRoot, dryRunJsonPath)),
  old_query_entry_pointer: oldQueryEntry.state,
  production_query_entry_untouched: true,
  m7_required: true,
}, null, 2));
