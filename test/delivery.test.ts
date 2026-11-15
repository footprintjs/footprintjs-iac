import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { queryRecordedDependencies, type RecordedDependencyInput } from '../src/diagnostics/recorded.ts';
import { DeliveryWorkflow, FileDeliveryStore, loadDeliveryRecording } from '../src/delivery/node.ts';
import { GitSourceAdapter } from '../src/delivery-git/index.ts';
import { readDeliveryArtifacts, readDeliveryDefinition, readDeliveryState, type DeliveryAdapters, type DeliveryDefinition, type DeliveryStageId } from '../src/delivery/index.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-delivery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const definition: DeliveryDefinition = { id: 'release-v2', label: 'Application release', target: { id: 'company-cluster', scope: 'cluster/namespace' },
    source: { repository: 'https://github.com/company/app.git', ref: 'v2' }, recipe: { id: 'app-images', digest: 'a'.repeat(64) }, configurationDigest: 'b'.repeat(64) };
  const controls: { fail?: DeliveryStageId; mismatch?: 'source' | 'recipe' | 'artifact'; verification: boolean; gate?: Promise<void> } = { verification: true };
  const calls: { stage: DeliveryStageId; operationId: string }[] = [], secret = 'PRIVATE-TEST-PASSWORD-MUST-NOT-APPEAR';
  const perform = async (stage: DeliveryStageId, operationId: string) => {
    calls.push({ stage, operationId });
    if (controls.fail === stage) throw Error(secret);
    if (stage === 'build' && controls.gate) await controls.gate;
  };
  const artifacts = [{ id: 'api', digest: 'sha256:' + 'c'.repeat(64), reference: 'local/app:v2' }];
  const adapters: DeliveryAdapters = {
    source: {
      async resolve(source, context) { await perform('resolve', context.operationId); return { ...source, commit: '1'.repeat(40), tree: '2'.repeat(40) }; },
      async fetch(revision, context) { await perform('fetch', context.operationId); return { revision: { ...revision, ...(controls.mismatch === 'source' ? { commit: '3'.repeat(40) } : {}) }, location: '/private/source/app' }; },
    },
    build: { async build(_source, recipe, context) { await perform('build', context.operationId); return { artifacts, recipeDigest: controls.mismatch === 'recipe' ? 'f'.repeat(64) : recipe.digest, metadata: { privateHostHandle: '/private/build/42' } }; } },
    artifacts: { async publish(build, context) { await perform('publish', context.operationId); return { artifacts: build.artifacts.map(artifact => ({ ...artifact, reference: 'registry/app@' + artifact.digest,
      ...(controls.mismatch === 'artifact' ? { digest: 'sha256:' + 'e'.repeat(64) } : {}) })) }; } },
    deployment: {
      async plan(_publication, context) { await perform('plan', context.operationId); return { id: 'review-2', digest: 'd'.repeat(64), changes: [{ resourceId: 'app', action: 'update' }], metadata: { privateReviewHandle: 'private-review' } }; },
      async deploy(_plan, context) { await perform('deploy', context.operationId); return { ok: true, runId: 'native-provider-run', evidencePath: '/private/provider-evidence.json', metadata: { privateHandle: 'private-deployment' } }; },
      async verify(_deployment, context) { await perform('verify', context.operationId); return { ok: controls.verification, checks: [{ id: 'real-access', passed: controls.verification }] }; },
    },
  };
  const store = new FileDeliveryStore(directory);
  return { directory, definition, controls, calls, secret, store, adapters,
    workflow: (change: Partial<DeliveryDefinition> = {}) => new DeliveryWorkflow({ definition: { ...definition, ...change }, store, adapters }) };
}

test('generic delivery runs seven actual native stages, syncs intent first, replays, and reopens without repeated effects', async t => {
  const f = await fixture(t), seen: string[] = [], workflow = f.workflow();
  workflow.subscribe(state => { seen.push(state.status + ':' + state.stages.find(stage => stage.status === 'running')?.id); });
  const deploy = f.adapters.deployment.deploy;
  f.adapters.deployment.deploy = async (plan, context) => {
    const stored = await f.store.load(); assert.equal(stored!.stages.find(stage => stage.id === 'deploy')!.status, 'running');
    assert.equal(stored!.results.plan!.digest, plan.digest); return deploy(plan, context);
  };
  // Construct again so the immutable host adapter binding sees the checking seam above.
  const execution = f.workflow(); execution.subscribe(state => { seen.push(state.status + ':' + state.stages.find(stage => stage.status === 'running')?.id); });
  const result = await execution.start(); assert.equal(result.status, 'passed');
  assert.deepEqual(f.calls.map(call => call.stage), ['resolve', 'fetch', 'build', 'publish', 'plan', 'deploy', 'verify']);
  assert.equal(new Set(f.calls.map(call => call.operationId)).size, 7);
  assert.ok(seen.includes('running:build')); assert.ok(seen.includes('running:deploy'));
  assert.equal(result.events.length, 14); assert.equal(result.recordings.length, 1);
  assert.equal(result.results.source!.location, '/private/source/app');
  const recording = result.recordings[0]!, loaded = await loadDeliveryRecording(recording.evidencePath, { runId: recording.runId });
  const snapshot = loaded.snapshot as unknown as { sharedState: unknown; commitLog: unknown[] };
  assert.equal(snapshot.commitLog.length, 7);
  assert.equal((snapshot.sharedState as { definition: DeliveryDefinition }).definition.source.repository, f.definition.source.repository);
  const stored = readStoredRecord(readRecordFile(recording.tracePath).entries), log = stored.root(recording.runId)!;
  assert.equal(log.complete, true); assert.deepEqual(log.gaps, []);
  assert.deepEqual(stateAt(log, log.commitLog.length - 1).state, snapshot.sharedState);
  const dependencies = queryRecordedDependencies({ snapshot: loaded.snapshot, controlDeps: loaded.controlDeps } as unknown as RecordedDependencyInput, 'verification');
  assert.equal(dependencies.status, 'available'); assert.equal(dependencies.summary.nodes, 7);
  assert.equal(dependencies.provenance.recorded, 'reads-prefix');
  const evidenceBytes = await readFile(recording.evidencePath, 'utf8'), traceBytes = await readFile(recording.tracePath, 'utf8');
  for (const privateValue of ['/private/source/app', '/private/build/42', 'private-review', 'private-deployment', '/private/provider-evidence.json', f.secret]) {
    assert.equal(evidenceBytes.includes(privateValue), false); assert.equal(traceBytes.includes(privateValue), false);
  }
  assert.deepEqual(await f.workflow().start(), result); assert.equal(f.calls.length, 7);
  await assert.rejects(() => loadDeliveryRecording(recording.evidencePath, { runId: 'wrong' }), /differs/);
});

test('real local Git source paths and file URL repositories stay private across native definition and version receipts', async t => {
  for (const fileUrl of [false, true]) {
    const f = await fixture(t), localRepository = join(f.directory, 'private-local-repository');
    execFileSync('git', ['init', '-b', 'main', localRepository], { stdio: 'ignore' });
    await writeFile(join(localRepository, 'app.txt'), 'reviewed source\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Delivery test', '-c', 'user.email=delivery@example.invalid', '-C', localRepository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('add', '.'); git('commit', '-m', 'Reviewed source');
    const sourceAdapter = new GitSourceAdapter({ directory: join(f.directory, 'source-cache'), repository: localRepository, allowedRefs: ['main'], allowLocalRepository: true });
    const repository = fileUrl ? new URL('file://' + localRepository).href : localRepository;
    // A different host source adapter may identify local content with a file URL.
    // Delegate actual acquisition to the same real Git adapter, preserving its exact objects.
    f.adapters.source = fileUrl ? {
      async resolve(_source, context) { const revision = await sourceAdapter.resolve({ repository: localRepository, ref: 'main' }, context); return { ...revision, repository }; },
      async fetch(revision, context) { const fetched = await sourceAdapter.fetch({ ...revision, repository: localRepository }, context); return { ...fetched, revision }; },
    } : sourceAdapter;
    const workflow = f.workflow({ source: { repository, ref: 'main' } }), result = await workflow.start();
    assert.equal(result.status, 'passed'); assert.equal(result.results.revision!.repository, repository);
    assert.equal(result.results.revision!.commit, git('rev-parse', 'HEAD'));
    assert.ok((await readFile(f.store.path, 'utf8')).includes(localRepository), 'private ledger preserves exact host binding');
    const recording = result.recordings[0]!, native = await loadDeliveryRecording(recording.evidencePath);
    const shared = (native.snapshot as { sharedState: Record<string, unknown> }).sharedState;
    const identity = (shared.definition as DeliveryDefinition).source.repository;
    assert.match(identity, /^source-sha256:[a-f0-9]{64}$/);
    assert.equal((shared.revision as { repository: string }).repository, identity);
    assert.equal((shared.source as { revision: { repository: string } }).revision.repository, identity);
    for (const path of [recording.evidencePath, recording.tracePath]) {
      const bytes = await readFile(path, 'utf8');
      assert.equal(bytes.includes(localRepository), false); assert.equal(bytes.includes(repository), false);
      assert.equal(bytes.includes(result.results.source!.location), false);
    }
    assert.deepEqual(await workflow.snapshot(), result);
    assert.deepEqual(await workflow.start(), result, 'completed receipt integrity uses the same safe projection');
    const tampered = structuredClone(result); tampered.results.plan!.changes[0]!.action = 'create';
    await writeFile(f.store.path, JSON.stringify(tampered));
    await assert.rejects(() => workflow.snapshot(), /receipts differ/);
  }
});

test('every adapter failure stops downstream effects, retains native failed evidence and removes exception secrets', async t => {
  for (const stage of ['resolve', 'fetch', 'build', 'publish', 'plan', 'deploy', 'verify'] as const) {
    const f = await fixture(t); f.controls.fail = stage;
    const result = await f.workflow().start(); assert.equal(result.status, 'failed');
    assert.equal(f.calls.at(-1)!.stage, stage); assert.equal(result.stages.find(item => item.id === stage)!.status, 'failed');
    assert.equal(result.recordings[0]!.status, 'failed');
    for (const file of [f.store.path, result.recordings[0]!.evidencePath, result.recordings[0]!.tracePath]) assert.equal((await readFile(file, 'utf8')).includes(f.secret), false);
    const count = f.calls.length; await assert.rejects(() => f.workflow().start(), /already started/); assert.equal(f.calls.length, count);
  }
});

test('source, recipe and publication identity changes are rejected before deployment', async t => {
  for (const mismatch of ['source', 'recipe', 'artifact'] as const) {
    const f = await fixture(t); f.controls.mismatch = mismatch;
    const result = await f.workflow().start(); assert.equal(result.status, 'failed');
    assert.equal(f.calls.some(call => call.stage === 'deploy'), false);
  }
  const f = await fixture(t); f.controls.verification = false;
  const result = await f.workflow().start(); assert.equal(result.status, 'failed'); assert.equal(result.results.verification!.ok, false);
});

test('a changed definition or uncertain prior execution cannot silently restart on the same durable target', async t => {
  const f = await fixture(t), result = await f.workflow().start();
  await assert.rejects(() => f.workflow({ source: { ...f.definition.source, ref: 'main' } }).snapshot(), /changed/);
  const substitutedPlan = structuredClone(result); substitutedPlan.results.plan!.changes[0]!.action = 'create';
  await writeFile(f.store.path, JSON.stringify(substitutedPlan));
  await assert.rejects(() => f.workflow().snapshot(), /receipts differ/);
  const substitutedArtifact = structuredClone(result); substitutedArtifact.results.publication!.artifacts[0]!.reference = 'registry/different@sha256:' + 'c'.repeat(64);
  await writeFile(f.store.path, JSON.stringify(substitutedArtifact));
  await assert.rejects(() => f.workflow().start(), /receipts differ/);
  const uncertain = structuredClone(result); uncertain.status = 'running'; uncertain.recordings = [];
  await writeFile(f.store.path, JSON.stringify(uncertain));
  await assert.rejects(() => f.workflow().start(), /already started/); assert.equal(f.calls.length, 7);
  const corrupt = structuredClone(result); corrupt.stages[2]!.status = 'pending';
  assert.throws(() => readDeliveryState(corrupt), /Unsupported/);
  const changed = structuredClone(result); changed.results.source!.revision.commit = '4'.repeat(40);
  assert.throws(() => readDeliveryState(changed), /Unsupported/);
});

test('concurrent starts reject an occupied ledger so only one immutable delivery reaches adapters', async t => {
  const f = await fixture(t); let release!: () => void;
  f.controls.gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.workflow().start();
  while (!f.calls.some(call => call.stage === 'build')) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(() => f.workflow().start(), /locked/); release();
  const a = await first; assert.equal(a.status, 'passed'); assert.deepEqual(await f.workflow().start(), a); assert.equal(f.calls.length, 7);
});

test('pure declaration admission refuses accessors and credential-bearing repository URLs without executing adapters', () => {
  let reads = 0;
  assert.throws(() => readDeliveryDefinition({ get id() { reads++; return 'bad'; } }), /accessors/); assert.equal(reads, 0);
  for (const repository of ['https://user:password@github.com/company/app', 'https://github.com/company/app?token=private', 'https://github.com/company/app#private']) {
    assert.throws(() => readDeliveryDefinition({ id: 'release', label: 'Release', target: { id: 'target', scope: 'fixed' },
      source: { repository, ref: 'main' }, recipe: { id: 'build', digest: 'a'.repeat(64) }, configurationDigest: 'b'.repeat(64) }), /Unsupported/);
  }
  for (const reference of ['https://user:password@registry.example/app', 'https://registry.example/app?token=private', 'registry.example/app#private', 'user:password@registry.example/app']) {
    assert.throws(() => readDeliveryArtifacts([{ id: 'api', digest: 'a'.repeat(64), reference }]), /Unsupported/);
  }
  assert.equal(readDeliveryArtifacts([{ id: 'api', digest: 'a'.repeat(64), reference: 'registry.example/app@sha256:' + 'a'.repeat(64) }]).length, 1);
});
