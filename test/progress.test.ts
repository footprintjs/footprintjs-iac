import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import type { EmitEvent, RuntimeSnapshot } from 'footprintjs';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import { createDeploymentRecorder, DEPLOYMENT_EVENT, type DeploymentEvent } from '../src/progress/index.ts';
import type { Resource } from '../src/types.ts';

const resource = (id: string, dependsOn: string[] = []): Resource => ({ id, provider: 'simulator', dependsOn, spec: { fixture: id } });

async function fixture(t: { after(fn: () => Promise<void>): void }, adapter = new SimulatorAdapter(), maxConcurrency = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = createDeploymentRecorder();
  const store = new FileStateStore(join(directory, 'state'));
  const engine = new InfraEngine({ adapters: [adapter], store, traceDirectory: join(directory, 'traces'),
    strategy: new ReconcileStrategy(1), maxConcurrency, recorders: [recorder] });
  return { directory, recorder, store, engine };
}

class GatedReadyAdapter extends SimulatorAdapter {
  private releaseReady!: () => void;
  private readonly ready = new Promise<void>(resolve => { this.releaseReady = resolve; });
  private enteredReady!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enteredReady = resolve; });
  waiting = false;
  release(): void { this.releaseReady(); }
  override async waitReady(item?: Resource): Promise<void> {
    if (item?.id === 'app') { this.waiting = true; this.enteredReady(); await this.ready; }
  }
}

test('native progress stays deploying until provider readiness and persists the full event projection', { timeout: 30000 }, async t => {
  const adapter = new GatedReadyAdapter();
  const { recorder, engine } = await fixture(t, adapter);
  const received: DeploymentEvent[] = [];
  const unsubscribe = recorder.subscribe(event => { received.push(event); });
  recorder.subscribe(() => { throw new Error('A broken dashboard subscriber'); });
  const apply = engine.apply({ name: 'ready', resources: [resource('app'), resource('endpoint', ['app'])] });
  try {
    await Promise.race([adapter.entered, apply.then(() => { throw Error('The deployment finished without entering the provider readiness gate'); })]);
    assert.equal(adapter.waiting, true);
    assert.equal(recorder.getSnapshot().resources.app?.status, 'deploying');
    assert.equal(recorder.getSnapshot().resources.endpoint?.status, 'pending');
  } finally { adapter.release(); }
  const result = await apply;
  unsubscribe();
  assert.equal(result.ok, true);
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.runId, result.runId);
  assert.deepEqual(snapshot.events.filter(event => event.resourceId === 'app').map(event => event.status), ['pending', 'deploying', 'ready']);
  assert.equal(snapshot.resources.endpoint?.status, 'ready');
  assert.equal(snapshot.subscriberFailures, received.length);
  assert.deepEqual(snapshot.events.map(event => event.sequence), snapshot.events.map((_, index) => index + 1));
  assert.deepEqual(recorder.getEvents(2), snapshot.events.slice(2));
  assert.ok(Object.isFrozen(snapshot.resources));
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
    snapshot: RuntimeSnapshot; structure: unknown;
  };
  assert.ok(evidence.structure);
  const row = evidence.snapshot.recorders?.find(item => item.id === recorder.id);
  assert.deepEqual(row?.data, snapshot);
  assert.equal((evidence.snapshot.sharedState['progress:app'] as { status: string }).status, 'ready');
  const streamed = readStoredRecord(readRecordFile(result.tracePath!).entries).root(evidence.snapshot.runId!);
  assert.ok(streamed?.complete);
  assert.deepEqual(stateAt(streamed, streamed.commitLog.length - 1).state, evidence.snapshot.sharedState);
});

test('a repeated no-op run resets its projection and reports readiness without a provider mutation', async t => {
  const adapter = new SimulatorAdapter();
  const { recorder, engine } = await fixture(t, adapter);
  const stack = { name: 'noop-progress', resources: [resource('app')] };
  const first = await engine.apply(stack);
  adapter.calls.length = 0;
  const second = await engine.apply(stack);
  assert.notEqual(first.runId, second.runId);
  assert.equal(adapter.calls.length, 0);
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.runId, second.runId);
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.events[0]!.sequence, 1);
  assert.ok(snapshot.events.every(event => event.action === 'noop' && event.runId === second.runId));
  assert.equal(snapshot.resources.app?.status, 'ready');
});

test('a failed parallel sibling is red, a settled sibling remains ready and later resources are skipped', async t => {
  const adapter = new SimulatorAdapter({ faults: {
    failBeforeApply: new Set(['bad']), afterEffect: async item => { if (item.id === 'sibling') await delay(25); },
  } });
  const { recorder, engine } = await fixture(t, adapter, 2);
  const result = await engine.apply({ name: 'parallel-progress', resources: [resource('bad'), resource('sibling'), resource('downstream', ['bad'])] });
  assert.equal(result.ok, false);
  const snapshot = recorder.getSnapshot();
  assert.equal(snapshot.resources.bad?.status, 'failed');
  assert.match(snapshot.resources.bad?.message ?? '', /Injected failure/);
  assert.equal(snapshot.resources.sibling?.status, 'ready');
  assert.equal(snapshot.resources.downstream?.status, 'skipped');
  assert.equal(snapshot.events.filter(event => event.resourceId === 'downstream' && event.status === 'deploying').length, 0);
  assert.ok(snapshot.events.find(event => event.resourceId === 'sibling' && event.status === 'ready')!.sequence
    < snapshot.resources.downstream.sequence);
});

test('confirmed pruning reports deleted rather than resource readiness', async t => {
  const { recorder, engine } = await fixture(t);
  await engine.apply({ name: 'delete-progress', resources: [resource('app')] });
  const result = await engine.apply({ name: 'delete-progress', resources: [] }, { prune: true });
  assert.equal(result.ok, true);
  assert.deepEqual(recorder.getSnapshot().events.map(event => [event.status, event.action]), [
    ['pending', 'delete'], ['deploying', 'delete'], ['deleted', 'delete'],
  ]);
});

function native(payload: unknown): EmitEvent {
  return { name: DEPLOYMENT_EVENT, payload, timestamp: 1, runtimeStageId: 'stage#0', stageName: 'stage', pipelineId: 'native-run', subflowPath: [] };
}

test('the projection preserves whole identities and rejects cross-run or accessor-bearing events without invoking them', () => {
  const recorder = createDeploymentRecorder();
  const resourceId = 'complete-resource-identifier-'.repeat(20);
  const payload = { version: 1, runId: 'first', resourceId, status: 'pending', action: 'create' };
  recorder.onEmit!(native(payload));
  recorder.onEmit!(native({ ...payload, runId: 'other', status: 'ready' }));
  let getterCalls = 0;
  recorder.onEmit!(native({ ...payload, get message() { getterCalls++; return 'hidden'; } }));
  recorder.onEmit!(native({ ...payload, status: 'invented' }));
  assert.equal(getterCalls, 0);
  assert.equal(recorder.getSnapshot().ignoredEvents, 3);
  assert.equal(recorder.getSnapshot().resources[resourceId]?.resourceId, resourceId);
  assert.equal(recorder.getSnapshot().resources[resourceId]?.status, 'pending');
  assert.throws(() => recorder.getEvents(-1), /nonnegative/);
  recorder.clear!();
  recorder.onEmit!(native({ ...payload, runId: 'next' }));
  assert.equal(recorder.getSnapshot().sequence, 1);
  assert.equal(recorder.getSnapshot().runId, 'next');
});

test('custom native observer failures stay isolated and cannot replace the internal control recorder', async t => {
  const { directory, store } = await fixture(t);
  const recorder = createDeploymentRecorder();
  const engine = new InfraEngine({ adapters: [new SimulatorAdapter()], store, traceDirectory: join(directory, 'extra-traces'), recorders: [
    { id: 'throwing-view', onEmit() { throw new Error('Observer failure'); } }, recorder,
  ] });
  const result = await engine.apply({ name: 'isolated', resources: [resource('app')] });
  assert.equal(result.ok, true);
  assert.equal(recorder.getSnapshot().resources.app?.status, 'ready');
  assert.throws(() => new InfraEngine({ adapters: [], store, recorders: [{ id: 'iac-internal-control-dependencies' }] }), /reserved/);
  assert.throws(() => new InfraEngine({ adapters: [], store, recorders: [recorder, recorder] }), /Duplicate/);
});
