import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InfraEngine } from '../src/engine.ts';
import { compileGraph } from '../src/graph/compile.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import { createDeploymentRecorder } from '../src/progress/index.ts';
import { defineSystemRevision, diffSystemRevisions, fingerprintPlan, readSystemRevision } from '../src/master/index.ts';
import { FileMasterStore, MasterWorkflow } from '../src/master/node.ts';
import type { MasterState, SystemRevision } from '../src/master/types.ts';
import type { ProviderContext, Resource } from '../src/types.ts';

const target = { id: 'local-example', scope: 'simulator:owned-local-system' };
const graph = (version = 1) => compileGraph({ name: 'master-example', boundaries: [], memberships: [], relations: [], resources: [
  { id: 'app', provider: 'simulator', dependsOn: ['storage'], spec: { image: `example:version-${version}`, replicas: 1 } },
  { id: 'network', provider: 'simulator', dependsOn: ['app'], spec: { port: 80 } },
  { id: 'storage', provider: 'simulator', spec: { capacity: 10 } },
] });
const revision = (id: string, version: number, parentDigest: string | null = null) => defineSystemRevision({
  revisionId: id, parentDigest, target, graph: graph(version),
  source: { repository: 'https://example.test/neo', commit: String(version).repeat(40) },
  artifacts: [{ id: 'app-image', digest: String(version).repeat(64), reference: `example:version-${version}` }],
});

async function fixture(t: { after(fn: () => Promise<void>): void }, provider = new SimulatorAdapter()) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-master-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = createDeploymentRecorder(), state = new FileStateStore(join(directory, 'state'));
  const engine = new InfraEngine({ adapters: [provider], store: state, traceDirectory: join(directory, 'traces'),
    strategy: new ReconcileStrategy(1), recorders: [recorder], chartObservers: [recorder] });
  const store = new FileMasterStore(join(directory, 'master')), workflow = new MasterWorkflow({ engine, store, target });
  return { directory, recorder, state, engine, provider, store, workflow };
}
async function baseline(f: Awaited<ReturnType<typeof fixture>>) {
  const first = revision('neo-v1', 1), result = await f.engine.apply(first.graph);
  assert.equal(result.ok, true); f.provider.calls.length = 0;
  await f.workflow.adopt(first, result);
  assert.equal(f.provider.calls.length, 0, 'adopting complete current evidence cannot invoke a provider mutation');
  return first;
}

test('master JSON separates schema/revision/run, detaches data, commits graph metadata and describes exact resource differences', () => {
  const first = revision('neo-v1', 1), second = revision('neo-v2', 2, first.digest);
  assert.equal(first.schemaVersion, 1); assert.equal(second.schemaVersion, 1);
  assert.notEqual(first.digest, second.digest); assert.notEqual(first.graph.digest, second.graph.digest);
  assert.equal('runId' in first, false);
  assert.ok(Object.isFrozen(second) && Object.isFrozen(second.graph.resources[0]!.spec));
  assert.deepEqual(readSystemRevision(JSON.parse(JSON.stringify(second))), second);
  const changes = diffSystemRevisions(first, second);
  assert.deepEqual(changes.counts, { added: 0, changed: 1, removed: 0, unchanged: 2 });
  assert.deepEqual(changes.resources.find(row => row.resourceId === 'app'), { resourceId: 'app', kind: 'changed', paths: ['spec.image'] });
  assert.ok(changes.metadataChanged);
  const tampered = structuredClone(second); (tampered.graph.resources[0]!.spec).image = 'changed-without-a-digest';
  assert.throws(() => readSystemRevision(tampered), /digest/);
  let invoked = false;
  assert.throws(() => readSystemRevision({ ...second, get graph() { invoked = true; return second.graph; } }));
  assert.equal(invoked, false);
  assert.throws(() => defineSystemRevision({ revisionId: 'bad', parentDigest: null, target, graph: graph(),
    source: { repository: 'https://user:password@example.test/neo' } }), /credential-free/);
});

test('adopt existing baseline, stage/review immutable JSON, and upgrade only the changed resource in one real native run', async t => {
  const f = await fixture(t), first = await baseline(f), second = revision('neo-v2', 2, first.digest);
  const staged = await f.workflow.stage(second, { expectedAppliedDigest: first.digest });
  assert.equal(staged.appliedDigest, first.digest); assert.equal(staged.candidateDigest, second.digest);
  assert.equal(f.provider.calls.length, 0);
  const review = await f.workflow.preview();
  assert.match(review.reviewId, /^[a-f0-9]{64}$/); assert.equal(review.planDigest, fingerprintPlan(review.plan));
  assert.deepEqual(review.plan.operations.map(operation => [operation.resource.id, operation.action]), [['storage', 'noop'], ['app', 'update'], ['network', 'noop']]);
  assert.equal(f.provider.calls.length, 0, 'review observes but never applies');
  const before = JSON.parse(await readFile(f.store.path, 'utf8')) as MasterState;
  assert.equal(before.review?.reviewId, review.reviewId);
  const result = await f.workflow.apply(review.reviewId);
  assert.equal(result.ok, true); assert.deepEqual(f.provider.calls.map(call => [call.id, call.action]), [['app', 'apply']]);
  assert.ok(f.recorder.getEvents().every(event => event.runId === result.runId));
  assert.deepEqual(f.recorder.getEvents().filter(event => event.status === 'ready').map(event => [event.resourceId, event.action]), [['storage', 'noop'], ['app', 'update'], ['network', 'noop']]);
  const saved = await f.workflow.getState();
  assert.equal(saved.appliedDigest, second.digest); assert.equal(saved.candidateDigest, null); assert.equal(saved.review, undefined);
  assert.deepEqual(saved.revisions, [first, second]); assert.equal(saved.attempts[1]!.runId, result.runId);
  assert.equal(saved.attempts[1]!.status, 'applied');
  const reload = new MasterWorkflow({ engine: f.engine, store: new FileMasterStore(f.store.directory), target });
  assert.deepEqual(await reload.getState(), saved, 'revision graph and both native attempts survive process-local workflow replacement');
});

test('unchanged master reapply is a recorded check, not a recreate or an extra version', async t => {
  const f = await fixture(t), first = await baseline(f);
  await f.workflow.stage(first, { expectedAppliedDigest: first.digest });
  const review = await f.workflow.preview(); assert.ok(review.plan.operations.every(operation => operation.action === 'noop'));
  const result = await f.workflow.apply(review.reviewId); assert.equal(result.ok, true); assert.equal(f.provider.calls.length, 0);
  const saved = await f.workflow.getState(); assert.equal(saved.revisions.length, 1); assert.equal(saved.attempts.length, 2);
});

test('a changed candidate/head invalidates an old review before any provider mutation', async t => {
  const f = await fixture(t), first = await baseline(f), second = revision('neo-v2', 2, first.digest), third = revision('neo-v3', 3, first.digest);
  await f.workflow.stage(second, { expectedAppliedDigest: first.digest }); const stale = await f.workflow.preview();
  await f.workflow.stage(third, { expectedAppliedDigest: first.digest });
  await assert.rejects(f.workflow.apply(stale.reviewId), /stale/);
  await assert.rejects(f.workflow.stage(second, { expectedAppliedDigest: null }), /changed/);
  await assert.rejects(f.workflow.stage(revision('bad-parent', 2), { expectedAppliedDigest: first.digest }), /parent/);
  assert.equal(f.provider.calls.length, 0); assert.equal((await f.workflow.getState()).attempts.length, 1);
});

test('live drift after review rejects the sealed plan under the engine lock before all effects', async t => {
  const f = await fixture(t), first = await baseline(f), second = revision('neo-v2', 2, first.digest);
  await f.workflow.stage(second, { expectedAppliedDigest: first.digest }); const review = await f.workflow.preview();
  await f.provider.injectDrift('storage', { capacity: 99 });
  await assert.rejects(f.workflow.apply(review.reviewId), /reviewed plan is stale/);
  assert.equal(f.provider.calls.length, 0);
  const failed = await f.workflow.getState(); assert.equal(failed.appliedDigest, first.digest); assert.equal(failed.attempts[1]!.status, 'incomplete');
  const updated = await f.workflow.preview(); assert.notEqual(updated.planDigest, review.planDigest);
  assert.equal(updated.plan.operations.find(operation => operation.resource.id === 'storage')?.action, 'update');
  assert.equal((await f.workflow.apply(updated.reviewId)).ok, true);
});

class LateDrift extends SimulatorAdapter {
  armed = false;
  override async observe(resource: Resource, context: ProviderContext) {
    if (this.armed && resource.id === 'network' && context.operationId !== 'plan') {
      this.armed = false; await this.injectDrift('network', { port: 9999 });
    }
    return super.observe(resource, context);
  }
}
test('late drift on a reviewed noop never silently repairs an unreviewed resource; failed master head stays honest', async t => {
  const adapter = new LateDrift(), f = await fixture(t, adapter), first = await baseline(f), second = revision('neo-v2', 2, first.digest);
  await f.workflow.stage(second, { expectedAppliedDigest: first.digest }); const review = await f.workflow.preview(); adapter.armed = true;
  const result = await f.workflow.apply(review.reviewId); assert.equal(result.ok, false);
  assert.deepEqual(adapter.calls.map(call => call.id), ['app']);
  assert.equal(result.failure?.resourceId, 'network'); assert.match(result.failure!.message, /reviewed check.*mutation/);
  const saved = await f.workflow.getState(); assert.equal(saved.appliedDigest, first.digest); assert.equal(saved.candidateDigest, second.digest);
  assert.equal(saved.attempts[1]!.status, 'failed'); assert.equal(saved.attempts[1]!.runId, result.runId);
  assert.equal((await f.engine.plan(second.graph)).operations.find(operation => operation.resource.id === 'app')?.action, 'noop', 'partial successful effects remain visible in durable native state');
  const repair = await f.workflow.preview(); assert.equal(repair.plan.operations.find(operation => operation.resource.id === 'network')?.action, 'update');
  assert.equal((await f.workflow.apply(repair.reviewId)).ok, true);
  assert.equal((await f.workflow.getState()).appliedDigest, second.digest);
});

test('ordinary non-reviewed engine application retains its existing drift reconciliation behavior', async t => {
  const adapter = new LateDrift(), f = await fixture(t, adapter); await f.engine.apply(graph()); adapter.calls.length = 0; adapter.armed = true;
  const result = await f.engine.apply(graph(2)); assert.equal(result.ok, true);
  assert.deepEqual(adapter.calls.map(call => call.id), ['app', 'network']);
});

test('provider failure and incomplete capture never promote the candidate revision', async t => {
  const f = await fixture(t), first = await baseline(f), second = revision('neo-v2', 2, first.digest);
  f.provider.faults.failBeforeApply = new Set(['app']);
  await f.workflow.stage(second, { expectedAppliedDigest: first.digest });
  const failed = await f.workflow.apply((await f.workflow.preview()).reviewId); assert.equal(failed.ok, false);
  assert.equal((await f.workflow.getState()).appliedDigest, first.digest);
  f.provider.faults.failBeforeApply.clear();
  const faulty = new MasterWorkflow({ store: f.store, target, engine: { plan: f.engine.plan.bind(f.engine),
    async apply(...args) { const result = await f.engine.apply(...args); return { ...result, traceStatus: { entries: 0, failed: 1, flushed: false } }; } } });
  await assert.rejects(faulty.apply((await faulty.preview()).reviewId), /capture is incomplete/);
  const saved = await faulty.getState(); assert.equal(saved.appliedDigest, first.digest); assert.equal(saved.attempts.at(-1)!.status, 'incomplete');
});

test('baseline adoption requires matching complete native evidence and current readiness without updates', async t => {
  const f = await fixture(t), first = revision('neo-v1', 1), result = await f.engine.apply(first.graph); f.provider.calls.length = 0;
  await f.provider.injectDrift('storage', { capacity: 200 });
  await assert.rejects(f.workflow.adopt(first, result), /current ready system/);
  assert.equal((await f.workflow.getState()).appliedDigest, null); assert.equal(f.provider.calls.length, 0);
  await f.engine.apply(first.graph); f.provider.calls.length = 0;
  await assert.rejects(f.workflow.adopt(first, { ...result, runId: 'foreign-run' }), /does not match/);
  assert.equal((await f.workflow.getState()).revisions.length, 0);
  await assert.rejects(new MasterWorkflow({ store: f.store, engine: f.engine, target: { id: 'different', scope: 'other' } })
    .stage(first, { expectedAppliedDigest: null }), /target differs/);
});

test('malformed ledger is refused rather than replaced with an empty master system', async t => {
  const f = await fixture(t); await f.store.save(await f.store.load()); await writeFile(f.store.path, '{partial');
  await assert.rejects(f.store.load()); await assert.rejects(f.workflow.stage(revision('v1', 1), { expectedAppliedDigest: null }));
  assert.equal(await readFile(f.store.path, 'utf8'), '{partial'); assert.equal(f.provider.calls.length, 0);
});

test('the durable master intent must succeed before native provider effects begin', async t => {
  const f = await fixture(t), first = await baseline(f), second = revision('neo-v2', 2, first.digest);
  await f.workflow.stage(second, { expectedAppliedDigest: first.digest }); const review = await f.workflow.preview();
  class RefusedIntent extends FileMasterStore { override async save(state: MasterState) {
    if (state.attempts.at(-1)?.status === 'running') throw Error('Injected master intent failure'); return super.save(state);
  } }
  const guarded = new MasterWorkflow({ engine: f.engine, target, store: new RefusedIntent(f.store.directory) });
  await assert.rejects(guarded.apply(review.reviewId), /intent failure/); assert.equal(f.provider.calls.length, 0);
  assert.equal((await f.workflow.getState()).review!.reviewId, review.reviewId);
});

test('a reused native run cannot be passed off as a newly reviewed no-op attempt', async t => {
  const f = await fixture(t), first = revision('neo-v1', 1);
  await f.engine.apply(first.graph);
  const previous = await f.engine.apply(first.graph);
  await f.workflow.adopt(first, previous); f.provider.calls.length = 0;
  await f.workflow.stage(first, { expectedAppliedDigest: first.digest });
  const cached = new MasterWorkflow({ store: f.store, target, engine: {
    plan: f.engine.plan.bind(f.engine), apply: async () => previous,
  } });
  const review = await cached.preview(); assert.equal(review.planDigest, fingerprintPlan(previous.plan));
  await assert.rejects(cached.apply(review.reviewId), /newly reviewed attempt/);
  const saved = await cached.getState(); assert.equal(saved.attempts.at(-1)!.status, 'incomplete');
  assert.equal(saved.attempts.filter(item => item.status === 'applied').length, 1); assert.equal(f.provider.calls.length, 0);
});

test('reviewed engine options reject accessors and inherited digests before observing a provider', async t => {
  const f = await fixture(t); let invoked = false;
  await assert.rejects(f.engine.apply(graph(), { get expectedPlanDigest() { invoked = true; return 'a'.repeat(64); } }), /own data/);
  assert.equal(invoked, false); assert.equal(f.provider.calls.length, 0);
  await assert.rejects(f.engine.apply(graph(), Object.create({ expectedPlanDigest: 'a'.repeat(64) }) as { expectedPlanDigest: string }), /own data/);
  assert.equal(f.provider.calls.length, 0);
});
