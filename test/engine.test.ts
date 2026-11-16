import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RuntimeSnapshot } from 'footprintjs';
import { flattenCausalDAG, keysReadFromExecutionTree, sliceForKey, stateAt, type ControlDependency } from 'foottrace';
import { InfraEngine } from '../src/engine.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { FileStateStore } from '../src/store.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import type { Resource, StateStore } from '../src/types.ts';

const resource = (id: string, dependsOn: string[] = [], value = 1): Resource => ({ id, provider: 'simulator', dependsOn, spec: { value } });

async function fixture(t: { after(fn: () => Promise<void>): void }, adapter = new SimulatorAdapter()) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStateStore(directory);
  return { directory, store, adapter, engine: new InfraEngine({ adapters: [adapter], store, strategy: new ReconcileStrategy(1) }) };
}

test('engine applies dependencies in order and an unchanged deployment sends no mutations', async t => {
  const { engine, adapter, store } = await fixture(t);
  const stack = { name: 'demo', resources: [resource('app', ['network']), resource('network')] };
  const first = await engine.apply(stack);
  assert.equal(first.ok, true);
  assert.deepEqual(adapter.calls.map(call => [call.action, call.id]), [['apply', 'network'], ['apply', 'app']]);
  assert.deepEqual(Object.keys((await store.load('demo')).resources), ['network', 'app']);
  adapter.calls.length = 0;
  const second = await engine.apply(stack);
  assert.equal(second.ok, true);
  assert.deepEqual(second.plan.operations.map(operation => operation.action), ['noop', 'noop']);
  assert.equal(adapter.calls.length, 0);
});

test('engine updates managed fields and repairs observed drift', async t => {
  const { engine, adapter, store } = await fixture(t);
  const first = resource('config');
  first.spec.omitLater = 'old';
  assert.equal((await engine.apply({ name: 'demo', resources: [first] })).ok, true);
  adapter.calls.length = 0;
  const desired = resource('config', [], 2);
  assert.equal((await engine.apply({ name: 'demo', resources: [desired] })).ok, true);
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual((await store.load('demo')).resources.config!.resource.spec, { value: 2 });
  await adapter.injectDrift('config', { value: 99 });
  adapter.calls.length = 0;
  const repaired = await engine.apply({ name: 'demo', resources: [desired] });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.plan.operations[0]!.action, 'update');
  assert.equal(adapter.calls.length, 1);
  assert.equal((await engine.plan({ name: 'demo', resources: [desired] })).operations[0]!.action, 'noop');
});

test('engine preserves omitted resources by default and explicitly prunes in reverse dependency order', async t => {
  const { engine, adapter, store } = await fixture(t);
  const stack = { name: 'demo', resources: [resource('network'), resource('app', ['network'])] };
  assert.equal((await engine.apply(stack)).ok, true);
  adapter.calls.length = 0;
  assert.equal((await engine.apply({ name: 'demo', resources: [] })).ok, true);
  assert.equal(adapter.calls.length, 0);
  assert.equal(Object.keys((await store.load('demo')).resources).length, 2);
  assert.equal((await engine.apply({ name: 'demo', resources: [] }, { prune: true })).ok, true);
  assert.deepEqual(adapter.calls.map(call => [call.action, call.id]), [['delete', 'app'], ['delete', 'network']]);
  assert.deepEqual((await store.load('demo')).resources, {});
});

test('engine reconciles a lost response after an effect without sending apply twice', async t => {
  const adapter = new SimulatorAdapter({ faults: { loseResponseAfterApply: new Set(['app']) } });
  const { engine, store } = await fixture(t, adapter);
  const result = await engine.apply({ name: 'demo', resources: [resource('app')] });
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(result.results.app, { status: 'complete', action: 'create', attempts: 1, reconciled: true });
  assert.ok((await store.readJournal()).some(entry => entry.event === 'complete' && entry.detail?.includes('Reconciled after error')));
});

test('engine retains successful resources and skips downstream work after a failed operation', async t => {
  const adapter = new SimulatorAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  const { engine, store } = await fixture(t, adapter);
  const result = await engine.apply({ name: 'demo', resources: [resource('good'), resource('bad'), resource('dependent', ['bad'])] });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.resourceId, 'bad');
  assert.deepEqual(result.results.dependent, { status: 'skipped' });
  assert.deepEqual(adapter.calls.map(call => [call.action, call.id]), [['apply', 'good'], ['apply', 'bad']]);
  assert.equal((await adapter.observe(resource('good'), { stack: 'demo', operationId: 'inspect' })).exists, true);
  assert.ok((await store.load('demo')).resources.good);
  assert.ok((await store.readJournal()).some(entry => entry.event === 'failed' && entry.resourceId === 'bad'));
});

test('failed deployment evidence supports offline state replay and data/control backwalking', async t => {
  const adapter = new SimulatorAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  const { engine } = await fixture(t, adapter);
  const result = await engine.apply({ name: 'demo', resources: [resource('network'), resource('bad', ['network']), resource('downstream', ['bad'])] });
  const saved = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
    snapshot: RuntimeSnapshot;
    controlDeps: Record<string, ControlDependency>;
  };
  const { snapshot } = saved;
  const folded = stateAt(snapshot, snapshot.commitLog.length - 1);
  assert.deepEqual(folded.state, snapshot.sharedState);
  assert.equal(folded.skipped, undefined);
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  const failure = sliceForKey(snapshot.commitLog, 'failure', reads, {
    edgeAttribution: 'per-write', controlDeps: stageId => saved.controlDeps[stageId],
  });
  assert.ok(failure.root, 'failure must have a recorded writer');
  const nodes = flattenCausalDAG(failure.root);
  assert.ok(nodes.some(node => node.stageName === 'Reconcile bad'));
  assert.ok(nodes.some(node => node.stageName === 'Load desired resources'));
  assert.ok(nodes.some(node => node.stageName === 'Reconcile network'));
  assert.ok(nodes.some(node => node.parentEdges.some(edge => edge.kind === 'control')));
  const beforeFailure = stateAt(snapshot, 0);
  assert.equal(beforeFailure.state.failure, null);
  assert.equal(beforeFailure.state.failed, false);
  assert.equal(adapter.calls.length, 2, 'reading evidence must not rerun provider operations');
});

test('engine stops when provider outcome cannot be observed instead of blindly retrying', async t => {
  class UnknownOutcomeAdapter extends SimulatorAdapter {
    unknown = false;
    override async observe(...args: Parameters<SimulatorAdapter['observe']>) {
      if (this.unknown) throw new Error('Provider unavailable');
      return super.observe(...args);
    }
    override async apply(...args: Parameters<SimulatorAdapter['apply']>) {
      await super.apply(...args);
      this.unknown = true;
      throw new Error('Lost response');
    }
  }
  const adapter = new UnknownOutcomeAdapter();
  const { store } = await fixture(t, adapter);
  const engine = new InfraEngine({ adapters: [adapter], store, strategy: new ReconcileStrategy(3) });
  const result = await engine.apply({ name: 'demo', resources: [resource('app')] });
  assert.equal(result.ok, false);
  assert.equal(adapter.calls.length, 1);
  assert.ok((await store.readJournal()).some(entry => entry.detail?.includes('outcome unknown')));
});

test('engine persists operation intent before provider effects and fails closed when journal writing fails', async t => {
  const { store, adapter } = await fixture(t);
  const rejectingStore: StateStore = {
    load: store.load.bind(store), save: store.save.bind(store), withLock: store.withLock.bind(store), saveEvidence: store.saveEvidence.bind(store),
    append: async () => { throw new Error('Journal disk unavailable'); },
  };
  const engine = new InfraEngine({ adapters: [adapter], store: rejectingStore });
  const result = await engine.apply({ name: 'demo', resources: [resource('app')] });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /Journal disk unavailable/);
  assert.equal(adapter.calls.length, 0);
});

test('engine binds saved state to provider target and refuses switching targets before mutation', async t => {
  const { directory, engine, adapter, store } = await fixture(t);
  assert.equal((await engine.apply({ name: 'demo', resources: [resource('app')] })).ok, true);
  const other = new SimulatorAdapter({ file: join(directory, 'another-cloud.json') });
  const switched = new InfraEngine({ adapters: [other], store });
  await assert.rejects(switched.apply({ name: 'demo', resources: [resource('app')] }), /Provider target changed/);
  assert.equal(other.calls.length, 0);
  assert.equal(adapter.calls.length, 1);
});

test('a reopened engine cannot repeat an unsafe pending effect without explicit recorded reconciliation',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'unsafe-pending-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new FileStateStore(directory);let mutations=0;
  const adapter={name:'unsafe',scope:'owned-target',supportsSafeRetry:false,
    async observe(){return{exists:true,owned:true,ready:false};},async apply(){mutations++;throw Error('runtime-outcome-unknown');},
    async waitReady(){throw Error('not-ready');},async remove(){throw Error('not-supported');}};
  const stack={name:'owned-app',resources:[{id:'service',provider:adapter.name,spec:{version:1}}]};
  const first=await new InfraEngine({adapters:[adapter],store}).apply(stack);assert.equal(first.ok,false);assert.equal(mutations,1);
  await assert.rejects(()=>new InfraEngine({adapters:[adapter],store}).apply({...stack,resources:[{...stack.resources[0]!,spec:{version:2}}]}),/reconcil|pending|uncertain/);
  assert.equal(mutations,1);assert.ok((await store.load(stack.name)).resources.service!.pending);
});
