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
const proposalPath = args.proposal;
const rollbackDryRunPath = args.rollbackDryRun;
const qualityPath = args.quality;
const manifestPath = args.manifest;
const outRouteProofDir = args.routeProofOutDir || '.ai-coord/artifacts/formal-duckdb-migration/route-proof';
const outReadinessDir = args.readinessOutDir || '.ai-coord/artifacts/formal-duckdb-migration/switch-readiness';
const runId = args.runId || `route-proof-formal-duckdb-migration-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;

if (!proposalPath) throw new Error('missing --proposal');
if (!rollbackDryRunPath) throw new Error('missing --rollbackDryRun');
if (!qualityPath) throw new Error('missing --quality');
if (!manifestPath) throw new Error('missing --manifest');

const queryEntryPointer = 'metadata/query-entry/daily_basic.json';
const cleanCurrentPointer = 'data/clean/daily_basic/_current.json';
const targetDataset = 'daily_basic';
const targetPartition = 'month=2026-05';

const normalizePath = (file) => file.replaceAll('\\', '/');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
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

const readFileState = async (relativePath, parseJson = false, hash = false) => {
  const absolute = path.resolve(workspaceRoot, relativePath);
  try {
    const stat = await fs.stat(absolute);
    const state = {
      state: 'present',
      relative_path: normalizePath(path.relative(workspaceRoot, absolute)),
      absolute_path: normalizePath(absolute),
      size_bytes: stat.size,
      last_write_time: stat.mtime.toISOString(),
    };
    if (hash) state.sha256 = await sha256File(absolute);
    if (parseJson) state.parsed_json = await readJson(absolute);
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      state: 'absent',
      relative_path: normalizePath(relativePath),
      absolute_path: normalizePath(absolute),
    };
  }
};

const listFiles = async (dir, options = {}) => {
  const {
    excludeDirs = new Set(['.git', 'node_modules', 'data', '.ai-coord']),
    maxFiles = 20000,
  } = options;
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EPERM') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const rel = normalizePath(path.relative(workspaceRoot, absolute));
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || rel.startsWith('data/') || rel.startsWith('.ai-coord/')) continue;
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
        if (files.length > maxFiles) throw new Error(`file scan exceeded limit ${maxFiles}`);
      }
    }
  }
  return files;
};

const looksTextual = (file) => {
  const ext = path.extname(file).toLowerCase();
  return new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.py',
    '.ps1', '.yml', '.yaml', '.toml', '.sql', '.txt',
  ]).has(ext);
};

const scanForQueryEntryConsumers = async () => {
  const files = (await listFiles(workspaceRoot)).filter(looksTextual);
  const mentionPatterns = [
    /metadata[\\/]+query-entry/i,
    /query-entry/i,
    /query_entry/i,
    /queryEntry/i,
    /read_parquet/i,
    /source_fallback/i,
  ];
  const routingPatterns = [
    /metadata[\\/]+query-entry/i,
    /read_parquet/i,
    /source_fallback/i,
    /switch_grain/i,
    /dataset\/window/i,
    /daily_basic/i,
  ];
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!mentionPatterns.some((pattern) => pattern.test(text))) continue;
    const relative = normalizePath(path.relative(workspaceRoot, file));
    const matchingRoutingSignals = routingPatterns
      .filter((pattern) => pattern.test(text))
      .map((pattern) => pattern.source);
    const governanceOnly =
      relative.startsWith('tools/formal-duckdb-migration/') ||
      relative.startsWith('tools/data-weight-control/') ||
      relative.startsWith('.kiro/');
    findings.push({
      path: relative,
      governance_only: governanceOnly,
      routing_signal_count: matchingRoutingSignals.length,
      signals: matchingRoutingSignals,
    });
  }
  const productionCandidates = findings.filter((item) => !item.governance_only && item.routing_signal_count >= 2);
  return {
    scanned_text_files: files.length,
    query_entry_dir_exists: (await readFileState('metadata/query-entry')).state === 'present',
    findings_count: findings.length,
    findings: findings
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, 50),
    production_candidate_count: productionCandidates.length,
    production_candidates: productionCandidates
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, 25),
    deterministic_dataset_window_mixed_routing_proven: productionCandidates.length > 0,
  };
};

const parseStrictDate = (value) => {
  if (value === null || value === undefined || value === '') {
    return { status: 'missing' };
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { status: 'invalid' };
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { status: 'invalid' };
  }
  return { status: 'valid', value };
};

const classifyRoute = (candidatePointer, tradeDate) => {
  const parsed = parseStrictDate(tradeDate);
  if (parsed.status === 'missing') {
    return {
      input_trade_date: tradeDate,
      classification: 'missing-date',
      route_type: 'unresolved',
      accepted: false,
      reason: 'missing trade_date cannot be silently routed',
    };
  }
  if (parsed.status === 'invalid') {
    return {
      input_trade_date: tradeDate,
      classification: 'invalid-date',
      route_type: 'rejected',
      accepted: false,
      reason: 'trade_date is not a valid YYYY-MM-DD date',
    };
  }

  const { start, end_exclusive: endExclusive } = candidatePointer.route.window;
  if (parsed.value >= start && parsed.value < endExclusive) {
    return {
      input_trade_date: tradeDate,
      classification: parsed.value === start ? 'boundary-start-inside' : 'inside-window',
      route_type: 'parquet-manifest',
      accepted: true,
      target_manifest: candidatePointer.route.target_manifest,
      target_manifest_status: candidatePointer.route.target_manifest_status,
      reason: `${start} <= trade_date < ${endExclusive}`,
    };
  }

  return {
    input_trade_date: tradeDate,
    classification: parsed.value === endExclusive ? 'boundary-end-exclusive-outside' : 'outside-window',
    route_type: 'source-duckdb',
    accepted: true,
    source_fallback: true,
    reason: `trade_date outside ${start} <= trade_date < ${endExclusive}`,
  };
};

const assertNoForbiddenStateChange = (label, before, after) => {
  if (before.state !== after.state) throw new Error(`${label} state changed: ${before.state} -> ${after.state}`);
  if (before.state === 'present') {
    if (before.size_bytes !== after.size_bytes) throw new Error(`${label} size changed`);
    if (before.sha256 && after.sha256 && before.sha256 !== after.sha256) throw new Error(`${label} sha256 changed`);
  }
};

const proposal = await readJson(proposalPath);
const rollbackDryRun = await readJson(rollbackDryRunPath);
const quality = await readJson(qualityPath);
const manifest = await readJson(manifestPath);

if (proposal.artifact_version !== 'formal-duckdb-migration/switch-proposal/v1') throw new Error('proposal artifact_version mismatch');
if (proposal.status !== 'prepared-production-switch-blocked-pending-routing-decision') throw new Error(`unexpected proposal status: ${proposal.status}`);
if (proposal.new_entry_candidate?.production_switch_allowed_by_this_artifact !== false) throw new Error('M6 proposal unexpectedly allows production switch');
if (rollbackDryRun.status !== 'passed') throw new Error(`rollback dry-run is not passed: ${rollbackDryRun.status}`);
if (rollbackDryRun.acceptance?.production_query_entry_untouched !== true) throw new Error('rollback dry-run did not prove production query-entry untouched');
if (quality.status !== 'passed' || quality.decision?.result !== 'quality-passed') throw new Error('quality gate is not passed');
if (manifest.schema_version !== 'clean-version-manifest/v1') throw new Error('manifest schema_version mismatch');
if (manifest.status !== 'quality-passed') throw new Error(`manifest is not quality-passed: ${manifest.status}`);
if (manifest.dataset !== targetDataset || manifest.partition_id !== targetPartition) throw new Error('manifest dataset/partition mismatch');

const queryEntryBefore = await readFileState(queryEntryPointer, true, true);
const cleanCurrentBefore = await readFileState(cleanCurrentPointer, true, true);
const manifestBefore = await readFileState(manifestPath, true, true);
const targetFilesBefore = [];
for (const [index, file] of (manifest.target_files || []).entries()) {
  targetFilesBefore.push({
    index,
    path: file.path,
    state: await readFileState(file.path, false, true),
  });
}

const candidatePointer = proposal.new_entry_candidate;
if (candidatePointer.dataset !== targetDataset) throw new Error('candidate dataset mismatch');
if (candidatePointer.switch_grain !== 'dataset/window') throw new Error('candidate switch grain mismatch');
if (candidatePointer.route?.partition_id !== targetPartition) throw new Error('candidate route partition mismatch');
if (candidatePointer.route?.target_manifest !== normalizePath(manifestPath)) throw new Error('candidate target manifest mismatch');
if (candidatePointer.route?.target_manifest_status !== 'quality-passed') throw new Error('candidate target manifest is not quality-passed');

const adapterScan = await scanForQueryEntryConsumers();
const sampleCases = [
  { name: 'boundary_start', trade_date: '2026-05-01', expected_route_type: 'parquet-manifest' },
  { name: 'inside_observed_min', trade_date: '2026-05-06', expected_route_type: 'parquet-manifest' },
  { name: 'inside_observed_max', trade_date: '2026-05-29', expected_route_type: 'parquet-manifest' },
  { name: 'boundary_window_end_inclusive_date', trade_date: '2026-05-31', expected_route_type: 'parquet-manifest' },
  { name: 'boundary_end_exclusive', trade_date: '2026-06-01', expected_route_type: 'source-duckdb' },
  { name: 'before_window', trade_date: '2026-04-30', expected_route_type: 'source-duckdb' },
  { name: 'after_window', trade_date: '2026-06-02', expected_route_type: 'source-duckdb' },
  { name: 'invalid_date', trade_date: '2026-13-01', expected_route_type: 'rejected' },
  { name: 'missing_date', trade_date: null, expected_route_type: 'unresolved' },
];
const routeCases = sampleCases.map((item) => ({
  ...item,
  result: classifyRoute(candidatePointer, item.trade_date),
}));
const routeChecks = {
  all_expected_routes_matched: routeCases.every((item) => item.result.route_type === item.expected_route_type),
  inside_routes_to_quality_manifest: routeCases
    .filter((item) => item.expected_route_type === 'parquet-manifest')
    .every((item) => item.result.target_manifest === normalizePath(manifestPath) && item.result.target_manifest_status === 'quality-passed'),
  outside_routes_to_source_fallback: routeCases
    .filter((item) => item.expected_route_type === 'source-duckdb')
    .every((item) => item.result.source_fallback === true),
  invalid_or_missing_not_silent: routeCases
    .filter((item) => item.expected_route_type === 'rejected' || item.expected_route_type === 'unresolved')
    .every((item) => item.result.accepted === false),
  production_query_entry_pointer_absent: queryEntryBefore.state === 'absent',
  clean_current_pointer_absent: cleanCurrentBefore.state === 'absent',
  manifest_quality_passed: manifest.status === 'quality-passed',
  m6_production_switch_disallowed: candidatePointer.production_switch_allowed_by_this_artifact === false,
  production_adapter_or_consumer_exists: adapterScan.deterministic_dataset_window_mixed_routing_proven,
};
routeChecks.artifact_local_route_proof_passed =
  routeChecks.all_expected_routes_matched &&
  routeChecks.inside_routes_to_quality_manifest &&
  routeChecks.outside_routes_to_source_fallback &&
  routeChecks.invalid_or_missing_not_silent &&
  routeChecks.manifest_quality_passed &&
  routeChecks.m6_production_switch_disallowed;

const readinessStatus = routeChecks.production_adapter_or_consumer_exists
  ? 'ready-for-separate-M7b-human-decision'
  : 'blocked-for-production-switch';
const blockerReasons = [];
if (!routeChecks.production_adapter_or_consumer_exists) {
  blockerReasons.push('No production query-entry adapter or routing consumer was found/proven for deterministic dataset/window mixed routing.');
}
if (queryEntryBefore.state === 'absent') blockerReasons.push('Production metadata/query-entry/daily_basic.json is absent.');
if (proposal.new_entry_candidate.production_switch_allowed_by_this_artifact === false) {
  blockerReasons.push('M6 proposal explicitly disallows production switch from the M6 artifact.');
}

const routeProof = {
  artifact_version: 'formal-duckdb-migration/route-proof/v1',
  spec: 'formal-duckdb-migration',
  stage: 'M7a-route-adapter-proof',
  task_id: 'T-formal-duckdb-migration-m7-route-adapter-proof',
  run_id: runId,
  created_at: new Date().toISOString(),
  agent: 'codex',
  status: routeChecks.artifact_local_route_proof_passed ? 'passed-artifact-local' : 'failed',
  scope: 'artifact-local candidate query-entry pointer only',
  inputs: {
    switch_proposal_artifact: normalizePath(proposalPath),
    rollback_dry_run_artifact: normalizePath(rollbackDryRunPath),
    quality_gate_artifact: normalizePath(qualityPath),
    clean_manifest_path: normalizePath(manifestPath),
  },
  candidate_pointer_sha256: sha256Text(canonicalJson(candidatePointer)),
  candidate_pointer: candidatePointer,
  route_window: candidatePointer.route.window,
  cases: routeCases,
  checks: routeChecks,
  adapter_scan: adapterScan,
  boundary_checks: {
    workspace_root: normalizePath(workspaceRoot),
    query_entry_pointer: queryEntryBefore,
    clean_current_pointer: cleanCurrentBefore,
    target_manifest: assertUnderWorkspace('manifest', manifestPath),
    target_files: (manifest.target_files || []).map((file, index) => assertUnderWorkspace(`target_file_${index}`, file.path)),
  },
  production_adapter_status: routeChecks.production_adapter_or_consumer_exists ? 'found-candidate-needs-production-review' : 'absent',
  production_switch_readiness: readinessStatus,
  no_write_statement: {
    production_query_entry_pointer_write: false,
    query_entry_switch: false,
    clean_current_pointer_write: false,
    data_clean_write: false,
    target_parquet_write: false,
    source_duckdb_write: false,
    source_duckdb_ddl: false,
    source_duckdb_copy_target: false,
    drop_source_table: false,
    archive_source_table: false,
    production_default_change: false,
    created_m7b_or_m8_tasks: false,
  },
};

const readiness = {
  artifact_version: 'formal-duckdb-migration/switch-readiness/v1',
  spec: 'formal-duckdb-migration',
  stage: 'M7a-switch-readiness',
  task_id: 'T-formal-duckdb-migration-m7-route-adapter-proof',
  run_id: runId,
  created_at: routeProof.created_at,
  agent: 'codex',
  status: readinessStatus,
  route_proof_status: routeProof.status,
  artifact_local_route_proof_passed: routeChecks.artifact_local_route_proof_passed,
  production_adapter_status: routeProof.production_adapter_status,
  blocking_reasons: blockerReasons,
  readiness_checks: {
    quality_manifest_available: manifest.status === 'quality-passed',
    route_proof_artifact_local_passed: routeChecks.artifact_local_route_proof_passed,
    production_adapter_or_consumer_exists: routeChecks.production_adapter_or_consumer_exists,
    production_query_entry_pointer_present: queryEntryBefore.state === 'present',
    clean_current_pointer_present: cleanCurrentBefore.state === 'present',
    rollback_dry_run_passed: rollbackDryRun.status === 'passed',
    m6_disallows_direct_switch: proposal.new_entry_candidate.production_switch_allowed_by_this_artifact === false,
  },
  next_allowed_step: {
    action: 'stop-after-claude-review',
    allowed_production_switch: false,
    human_decision_required: true,
    decision_options: [
      'Implement and prove a production query-entry routing consumer before a separately approved M7b switch task.',
      'Defer switching until whole daily_basic migration and verification supports whole-dataset switch.',
      'Keep DuckDB as the production source and leave the Parquet pilot quality-passed but unpublished.',
    ],
  },
  remaining_work_before_m7b: [
    'Implement or identify the production consumer of metadata/query-entry/daily_basic.json.',
    'Prove deterministic dataset/window routing with source-duckdb fallback outside month=2026-05.',
    'Create a fresh rollback artifact for the production pointer state at M7b time.',
    'Get Claude acceptance and explicit human approval for any M7b production switch task.',
    'Plan post-switch observation before expanding migration scope.',
  ],
  inputs: routeProof.inputs,
  no_write_statement: routeProof.no_write_statement,
};

const routeProofDirAbs = path.resolve(workspaceRoot, outRouteProofDir);
const readinessDirAbs = path.resolve(workspaceRoot, outReadinessDir);
const routeProofJsonPath = path.join(routeProofDirAbs, `${runId}.json`);
const routeProofMdPath = path.join(routeProofDirAbs, `${runId}.md`);
const readinessJsonPath = path.join(readinessDirAbs, `${runId}.json`);
const readinessMdPath = path.join(readinessDirAbs, `${runId}.md`);

const routeProofMd = `# M7a route proof

- Status: ${routeProof.status}
- Scope: ${routeProof.scope}
- Dataset/window: ${targetDataset} / ${targetPartition}
- Window predicate: ${candidatePointer.route.window.start} <= trade_date < ${candidatePointer.route.window.end_exclusive}
- Inside-window target: ${candidatePointer.route.target_manifest}
- Outside-window target: source-duckdb fallback
- Invalid/missing trade_date: rejected or unresolved
- Production adapter status: ${routeProof.production_adapter_status}
- Production switch readiness: ${routeProof.production_switch_readiness}
- Production query-entry pointer before proof: ${queryEntryBefore.state}
- Clean current pointer before proof: ${cleanCurrentBefore.state}

## Case Results

${routeCases.map((item) => `- ${item.name}: ${item.trade_date ?? '<missing>'} -> ${item.result.route_type} (${item.result.classification})`).join('\n')}

## No Writes

- Production query-entry pointer write: ${routeProof.no_write_statement.production_query_entry_pointer_write}
- Query-entry switch: ${routeProof.no_write_statement.query_entry_switch}
- Clean current pointer write: ${routeProof.no_write_statement.clean_current_pointer_write}
- Data clean write: ${routeProof.no_write_statement.data_clean_write}
- Target Parquet write: ${routeProof.no_write_statement.target_parquet_write}
- Source DuckDB write: ${routeProof.no_write_statement.source_duckdb_write}
`;

const readinessMd = `# M7a switch readiness

- Status: ${readiness.status}
- Route proof status: ${readiness.route_proof_status}
- Artifact-local route proof passed: ${readiness.artifact_local_route_proof_passed}
- Production adapter status: ${readiness.production_adapter_status}
- Allowed production switch: ${readiness.next_allowed_step.allowed_production_switch}
- Human decision required: ${readiness.next_allowed_step.human_decision_required}

## Blocking Reasons

${readiness.blocking_reasons.map((item) => `- ${item}`).join('\n')}

## Remaining Work Before M7b

${readiness.remaining_work_before_m7b.map((item) => `- ${item}`).join('\n')}
`;

await writeJsonAtomic(routeProofJsonPath, routeProof);
await fs.writeFile(routeProofMdPath, routeProofMd, 'utf8');
await writeJsonAtomic(readinessJsonPath, readiness);
await fs.writeFile(readinessMdPath, readinessMd, 'utf8');

const queryEntryAfter = await readFileState(queryEntryPointer, true, true);
const cleanCurrentAfter = await readFileState(cleanCurrentPointer, true, true);
const manifestAfter = await readFileState(manifestPath, true, true);
assertNoForbiddenStateChange('production query-entry pointer', queryEntryBefore, queryEntryAfter);
assertNoForbiddenStateChange('clean current pointer', cleanCurrentBefore, cleanCurrentAfter);
assertNoForbiddenStateChange('clean manifest', manifestBefore, manifestAfter);
for (const beforeItem of targetFilesBefore) {
  const after = await readFileState(beforeItem.path, false, true);
  assertNoForbiddenStateChange(`target parquet ${beforeItem.index}`, beforeItem.state, after);
}

console.log(JSON.stringify({
  route_proof_status: routeProof.status,
  switch_readiness_status: readiness.status,
  route_proof_artifact: normalizePath(path.relative(workspaceRoot, routeProofJsonPath)),
  switch_readiness_artifact: normalizePath(path.relative(workspaceRoot, readinessJsonPath)),
  production_adapter_status: routeProof.production_adapter_status,
  production_query_entry_pointer: queryEntryAfter.state,
  clean_current_pointer: cleanCurrentAfter.state,
  artifact_local_cases: routeCases.length,
  no_production_switch: true,
}, null, 2));

if (!routeChecks.artifact_local_route_proof_passed) process.exitCode = 2;
