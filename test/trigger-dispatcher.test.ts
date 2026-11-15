import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TriggerDispatcher, FileTriggerStore, ManualTriggerAdapter, IntervalTriggerAdapter, StageEventTriggerAdapter,
  pipelineStageEventReader, type TriggerDefinition, type StageEventReference } from '../src/triggers/node.ts';
import { PipelineWorkflow, FilePipelineStore, FilePipelineTargetStore, directStrategy } from '../src/pipeline/node.ts';
import { defineReleaseManifest } from '../src/releases/manifest.ts';
import type { CheckRequest, CheckRunner } from '../src/checks/types.ts';
import type { PipelineDefinition } from '../src/pipeline/types.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-triggers-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000, current = { id: 'v1', digest: 'b'.repeat(64) }, pass = true;
  const requests: CheckRequest[] = []; let gate: Promise<void> | undefined, entered: (() => void) | undefined;
  const runner: CheckRunner = { id: 'test', suites: () => [{ id: 'access', label: 'Access checks', digest: 'a'.repeat(64), kind: 'command' }], async run(request) {
    requests.push(request); entered?.(); if (gate) await gate;
    return { request, status: pass ? 'passed' : 'failed', checks: [{ id: 'access', status: pass ? 'passed' : 'failed' }] };
  } };
  const base: TriggerDefinition = { version: 1, id: 'monitor', label: 'Application monitor', adapterId: 'interval', kind: 'interval',
    configurationDigest: 'c'.repeat(64), runnerId: runner.id, suiteId: 'access', suiteDigest: 'a'.repeat(64), stageId: 'gamma', target: { id: 'local', scope: 'namespace/gamma' },
    overlap: 'skip', missed: 'coalesce', schedule: { everyMs: 100, startsAt: 1000 } };
  const store = new FileTriggerStore(directory);
  return { directory, store, base, runner, requests,
    setNow: (value: number) => { now = value; }, setCurrent: (value: typeof current) => { current = value; }, setPass: (value: boolean) => { pass = value; },
    setGate: (promise: Promise<void>, onEnter: () => void) => { gate = promise; entered = onEnter; },
    dispatcher: (definition = base, adapters = [new IntervalTriggerAdapter()] as import('../src/triggers/types.ts').TriggerAdapter[], leaseMs = 1000) =>
      new TriggerDispatcher({ definitions: [definition], adapters, checks: [runner], store, clock: () => now, leaseMs, readCurrent: async () => current }) };
}

test('durable due ticks dispatch one finite native monitor against the current deployed release and preserve failure/recovery', async t => {
  const f = await fixture(t), dispatcher = f.dispatcher();
  const first = (await dispatcher.tick())[0]!.result; assert.equal(first.status, 'passed');
  assert.equal(f.requests[0]!.releaseId, 'v1'); assert.equal(f.requests[0]!.reason, 'scheduled');
  assert.equal((await dispatcher.tick())[0]!.result.status, 'not-due'); assert.equal(f.requests.length, 1);
  f.setNow(1100); f.setCurrent({ id: 'v2', digest: 'd'.repeat(64) }); f.setPass(false);
  assert.equal((await f.dispatcher().tick())[0]!.result.status, 'failed');
  f.setNow(1200); f.setPass(true); assert.equal((await f.dispatcher().tick())[0]!.result.status, 'passed');
  const state = await dispatcher.snapshot(f.base.id);
  assert.deepEqual(state.invocations.map(run => run.status), ['passed','failed','passed']);
  assert.deepEqual(state.invocations.map(run => run.request!.releaseId), ['v1','v2','v2']);
  assert.ok(state.invocations.every(run => run.result!.recording!.complete));
  assert.equal(state.nextDueAt, 1300); assert.equal(f.requests.length, 3);
  assert.deepEqual(dispatcher.catalog(), [{ id: 'monitor', label: 'Application monitor', kind: 'interval', everyMs: 100 }]);
});

test('manual request dedupe survives restart, completed receipts cannot be forged, and unknown trigger IDs invoke no tools', async t => {
  const f = await fixture(t), { schedule: _, ...base } = f.base;
  const definition: TriggerDefinition = { ...base, kind: 'manual', adapterId: 'manual' }, adapters = [new ManualTriggerAdapter()];
  const first = await f.dispatcher(definition, adapters).dispatch('monitor', { requestId: 'click-1' }); assert.equal(first.status, 'passed');
  assert.equal((await f.dispatcher(definition, adapters).dispatch('monitor', { requestId: 'click-1' })).status, 'duplicate'); assert.equal(f.requests.length, 1);
  await assert.rejects(() => f.dispatcher(definition, adapters).dispatch('unknown', { requestId: 'click-2' }), /registered/);
  await assert.rejects(() => f.dispatcher(definition, adapters).dispatch('monitor', { requestId: 'click-2', command: 'sh' } as never), /data/); assert.equal(f.requests.length, 1);
  const state = structuredClone(await f.store.load('monitor')); state!.invocations[0]!.result!.result!.checks[0]!.id = 'forged';
  await f.store.save(state!);
  await assert.rejects(() => f.dispatcher(definition, adapters).dispatch('monitor', { requestId: 'click-1' }), /differs/); assert.equal(f.requests.length, 1);
  await assert.rejects(() => f.dispatcher({ ...definition, configurationDigest: 'e'.repeat(64) }, adapters).dispatch('monitor', { requestId: 'new' }), /configuration changed/);
});

test('missed interval policies coalesce at most once or retain a skip, without replaying an unbounded backlog', async t => {
  for (const missed of ['skip','coalesce'] as const) {
    const f = await fixture(t); f.setNow(1555);
    const dispatcher = f.dispatcher({ ...f.base, missed });
    assert.equal((await dispatcher.tick())[0]!.result.status, missed === 'skip' ? 'skipped' : 'passed');
    const state = await dispatcher.snapshot('monitor'); assert.equal(state.nextDueAt, 1600); assert.equal(state.invocations.length, 1);
    assert.equal((await dispatcher.tick())[0]!.result.status, 'not-due'); assert.equal(f.requests.length, missed === 'skip' ? 0 : 1);
  }
});

test('overlapping dispatches do not rerun a suite; expired leases retain uncertainty instead of manufacturing recovery', async t => {
  const f = await fixture(t), { schedule: _, ...base } = f.base;
  const definition: TriggerDefinition = { ...base, kind: 'manual', adapterId: 'manual' }, adapters = [new ManualTriggerAdapter()];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { entered = resolve; }); f.setGate(gate, entered);
  const dispatcher = f.dispatcher(definition, adapters, 50), first = dispatcher.dispatch('monitor', { requestId: 'click-1' }); await running;
  assert.equal((await dispatcher.dispatch('monitor', { requestId: 'click-2' })).status, 'overlap'); assert.equal(f.requests.length, 1);
  f.setNow(1051); assert.equal((await dispatcher.dispatch('monitor', { requestId: 'click-2' })).status, 'incomplete');
  release(); assert.equal((await first).status, 'incomplete');
  assert.equal((await dispatcher.dispatch('monitor', { requestId: 'click-3' })).status, 'incomplete'); assert.equal(f.requests.length, 1);
  assert.equal((await dispatcher.snapshot('monitor')).invocations[0]!.status, 'incomplete');
});

test('simultaneous scheduler transactions serialize before reading durable lease state', async t => {
  const f=await fixture(t),{schedule:_,...base}=f.base,definition:TriggerDefinition={...base,kind:'manual',adapterId:'manual'};
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),running=new Promise<void>(resolve=>{entered=resolve;});f.setGate(gate,entered);
  const first=f.dispatcher(definition,[new ManualTriggerAdapter()]).dispatch('monitor',{requestId:'same-time-1'});
  const second=f.dispatcher(definition,[new ManualTriggerAdapter()]).dispatch('monitor',{requestId:'same-time-2'});
  await running;assert.equal((await second).status,'overlap');release();assert.equal((await first).status,'passed');assert.equal(f.requests.length,1);
});

test('stage event adapter revalidates real native pipeline receipts, rejects forged/stale refs, and does not deploy from a monitor', async t => {
  const f = await fixture(t), release = defineReleaseManifest({ id: 'v2', source: { repository: 'https://github.com/company/app', ref: 'v2', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    recipe: { id: 'images', digest: 'f'.repeat(64) }, artifacts: [{ id: 'app', digest: 'sha256:' + 'd'.repeat(64), reference: 'registry.invalid/app@sha256:' + 'd'.repeat(64) }] });
  const definition: PipelineDefinition = { version: 1, id: 'release', label: 'Release', configurationDigest: 'c'.repeat(64), stages: [{ id: 'gamma', label: 'Gamma', target: f.base.target,
    strategyId: 'direct', adapterId: 'local', checks: [{ runnerId: 'test', suiteId: 'access', suiteDigest: 'a'.repeat(64) }], rollback: 'disabled', promotion: 'automatic' }] };
  let actual: string | null = null, effects = 0;
  const workflow = new PipelineWorkflow({ definition, release,
    store: new FilePipelineStore(join(f.directory, 'pipeline')), targetStore: new FilePipelineTargetStore(join(f.directory, 'targets')),
    registry: { strategies: [directStrategy()], checks: [f.runner], adapters: [{ id: 'local', label: 'Local', capabilities: ['deploy'],
      async execute() { effects++; actual = release.digest; return { status: 'succeeded' }; }, async observe() { return { known: true, releaseDigest: actual }; } }] } });
  const pipeline = await workflow.start(); assert.equal(pipeline.status, 'passed'); assert.equal(effects, 1); f.setCurrent({ id: release.id, digest: release.digest });
  const { schedule: _, ...base } = f.base;
  const trigger: TriggerDefinition = { ...base, kind: 'stage-event', adapterId: 'stage', source: { pipelineId: definition.id, definitionDigest: pipeline.definitionDigest } };
  const adapter = new StageEventTriggerAdapter('stage', pipelineStageEventReader(async id => id === definition.id ? workflow.snapshot() : undefined));
  const event = pipeline.events.findLast(event => event.phase === 'outcome' && event.stageId === 'gamma')!;
  const reference: StageEventReference = { pipelineId: definition.id, definitionDigest: pipeline.definitionDigest, executionId: pipeline.executionId!, stageId: 'gamma', sequence: event.sequence };
  const dispatcher = f.dispatcher(trigger, [adapter]);
  await assert.rejects(() => dispatcher.dispatch('monitor', { event: { ...reference, sequence: 1 } }), /stale|unverified/);
  await assert.rejects(() => dispatcher.dispatch('monitor', { event: { ...reference, executionId: 'forged' } }), /stale|unverified/);
  await assert.rejects(() => dispatcher.dispatch('monitor', { event: { ...reference, definitionDigest: '0'.repeat(64) } }), /bound/);
  assert.equal((await dispatcher.dispatch('monitor', { event: reference })).status, 'passed');
  assert.equal((await dispatcher.dispatch('monitor', { event: reference })).status, 'duplicate'); assert.equal(effects, 1);
  const stale = { ...trigger, id: 'stale-monitor' }; f.setCurrent({ id: 'v3', digest: 'e'.repeat(64) });
  const count = f.requests.length; assert.equal((await f.dispatcher(stale, [adapter]).dispatch(stale.id, { event: reference })).status, 'incomplete');
  assert.equal(f.requests.length, count); assert.equal(effects, 1);
  const recording = pipeline.recordings.at(-1)!; const recorded = JSON.parse(await readFile(recording.evidencePath, 'utf8')); recorded.snapshot.sharedState.stage.status = 'failed';
  await writeFile(recording.evidencePath, JSON.stringify(recorded));
  await assert.rejects(() => f.dispatcher({ ...trigger, id: 'tamper' }, [adapter]).dispatch('tamper', { event: reference }), /differs/);
});
