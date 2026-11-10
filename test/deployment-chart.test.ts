import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EmitEvent } from 'footprintjs';
import { compileGraph, FileStateStore, InfraEngine, SimulatorAdapter } from '../src/index.ts';
import { createDeploymentRecorder, DEPLOYMENT_EVENT, readDeploymentChart, type DeploymentChart, type DeploymentChartObserver } from '../src/progress/index.ts';

const graph = compileGraph({ name: 'native-chart', boundaries: [], memberships: [], relations: [], resources: [
  { id: 'a', provider: 'simulator', spec: {} }, { id: 'b', provider: 'simulator', spec: {} },
  { id: 'joined', provider: 'simulator', dependsOn: ['a', 'b'], spec: {} },
] });
async function fixture(t: { after(fn: () => Promise<void>): void }, options: {
  maxConcurrency?: number; before?: DeploymentChartObserver[]; after?: DeploymentChartObserver[];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-native-chart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = createDeploymentRecorder();
  const adapter = new SimulatorAdapter();
  const engine = new InfraEngine({ adapters: [adapter], store: new FileStateStore(join(directory, 'state')),
    traceDirectory: join(directory, 'traces'), recorders: [recorder], chartObservers: [...options.before ?? [], recorder, ...options.after ?? []],
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }) });
  return { directory, recorder, adapter, engine };
}

test('the unchanged native chart arrives after recorder reset and before the first progress event or provider effect', async t => {
  const { recorder, adapter, engine } = await fixture(t);
  const order: string[] = [];
  recorder.subscribeChart(chart => {
    order.push('chart');
    const snapshot = recorder.getSnapshot();
    assert.equal(snapshot.runId, chart.runId); assert.equal(snapshot.sequence, 0);
    assert.deepEqual(snapshot.events, []); assert.deepEqual(snapshot.resources, {});
    assert.equal(adapter.calls.length, 0, 'planning may observe but no provider mutation precedes chart publication');
    assert.equal(snapshot.chart, chart);
  });
  recorder.subscribe(event => {
    order.push('progress');
    assert.equal(recorder.getSnapshot().chart?.runId, event.runId);
  });
  const result = await engine.apply(graph);
  assert.equal(result.ok, true); assert.deepEqual(result.chartStatus, { published: true, failed: 0 });
  assert.equal(order[0], 'chart'); assert.equal(order.filter(item => item === 'chart').length, 1);
  const snapshot = recorder.getSnapshot(), chart = snapshot.chart!;
  assert.equal(chart.graphDigest, graph.digest); assert.equal(chart.stack, graph.name);
  assert.equal(chart.runId, result.runId); assert.equal(chart.structure.id, 'load-desired');
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.deepEqual(chart.structure, evidence.structure, 'the adapter serves the actual FootPrint chart, not another authored workflow');
  assert.deepEqual(chart, evidence.deploymentChart);
  assert.deepEqual(evidence.chartStatus, result.chartStatus);
  assert.equal(snapshot.ignoredCharts, 0);
});

test('default serial execution publishes serial native gates and explicit exact resource-stage mappings', async t => {
  const { recorder, engine } = await fixture(t);
  await engine.apply(graph);
  const chart = recorder.getSnapshot().chart!;
  assert.deepEqual(chart.resources.map(item => [item.resourceId, item.batchIndex]), [['a', 0], ['b', 1], ['joined', 2]]);
  let native = chart.structure.next;
  for (const mapping of chart.resources) {
    assert.equal(native?.id, mapping.gateStageId); assert.equal(native?.type, 'decider');
    assert.deepEqual(native?.children?.map(child => child.id), [mapping.executeStageId, mapping.skipStageId]);
    assert.equal(mapping.joinStageId, undefined);
    native = native?.next;
  }
  assert.equal(native, undefined);
});

test('bounded parallel execution publishes the real selector and join instead of guessing parallelism from dependencies', async t => {
  const { recorder, engine } = await fixture(t, { maxConcurrency: 2 });
  await engine.apply(graph);
  const chart = recorder.getSnapshot().chart!;
  assert.deepEqual(chart.resources.map(item => [item.resourceId, item.batchIndex]), [['a', 0], ['b', 0], ['joined', 1]]);
  const [a, b, joined] = chart.resources;
  const selector = chart.structure.next!;
  assert.equal(selector.type, 'selector'); assert.equal(selector.id, a!.gateStageId);
  assert.equal(a!.gateStageId, b!.gateStageId); assert.equal(a!.skipStageId, b!.skipStageId);
  assert.deepEqual(selector.children?.map(child => child.id), [a!.executeStageId, b!.executeStageId, a!.skipStageId]);
  assert.equal(selector.next?.id, a!.joinStageId); assert.equal(a!.joinStageId, b!.joinStageId);
  assert.equal(selector.next?.next?.id, joined!.gateStageId);
});

test('a fresh no-op run resets old topology and old progress before publishing its own chart', async t => {
  const { recorder, engine, adapter } = await fixture(t);
  const seen: string[] = [];
  recorder.subscribeChart(chart => { seen.push(chart.runId); assert.equal(recorder.getSnapshot().events.length, 0); });
  const first = await engine.apply(graph); const firstChart = recorder.getSnapshot().chart!;
  adapter.calls.length = 0;
  const second = await engine.apply(graph), snapshot = recorder.getSnapshot();
  assert.deepEqual(seen, [first.runId, second.runId]); assert.notEqual(first.runId, second.runId);
  assert.equal(snapshot.chart?.runId, second.runId); assert.ok(snapshot.chart?.resources.every(item => item.action === 'noop'));
  assert.equal(adapter.calls.length, 0);
  recorder.onChart(firstChart);
  assert.equal(recorder.getSnapshot().ignoredCharts, 1);
  assert.equal(recorder.getSnapshot().chart?.runId, second.runId);
  assert.ok(recorder.getSnapshot().events.every(event => event.runId === second.runId));
});

test('observer and subscriber failures are isolated, disclosed, and cannot mutate the native chart', async t => {
  let received = 0;
  const bad: DeploymentChartObserver = { id: 'bad-chart-view', onChart(chart) { (chart.structure as { name: string }).name = 'corrupt'; } };
  const after: DeploymentChartObserver = { id: 'later-chart-view', onChart(chart) { received++; assert.equal(chart.structure.name, 'Load desired resources'); } };
  const { recorder, engine } = await fixture(t, { before: [bad], after: [after] });
  recorder.subscribeChart(() => { throw Error('private subscriber failure'); });
  const result = await engine.apply(graph);
  assert.equal(result.ok, true); assert.deepEqual(result.chartStatus, { published: true, failed: 1 });
  assert.equal(received, 1); assert.equal(recorder.getSnapshot().subscriberFailures, 1);
  assert.equal(recorder.getSnapshot().chart!.structure.name, 'Load desired resources');
  assert.equal(recorder.getSnapshot().resources.joined?.status, 'ready');
});

test('chart admission rejects executable, accessor, cyclic or dangling stage metadata without invoking it', async t => {
  const { recorder, engine } = await fixture(t); await engine.apply(graph);
  const valid = recorder.getSnapshot().chart!;
  let invoked = false;
  const accessor = { ...valid, get structure() { invoked = true; return valid.structure; } };
  assert.throws(() => readDeploymentChart(accessor), /property/); assert.equal(invoked, false);
  const cyclic = structuredClone(valid); (cyclic.structure as unknown as { next: unknown }).next = cyclic.structure;
  for (const bad of [
    cyclic, { ...valid, graphDigest: 'invalid' },
    { ...valid, resources: [{ ...valid.resources[0], executeStageId: 'not-a-stage' }] },
    { ...valid, structure: { ...valid.structure, callback() {} } },
    { ...valid, resources: [valid.resources[0], valid.resources[0]] },
  ]) assert.throws(() => readDeploymentChart(bad));
  const copy = readDeploymentChart(valid); assert.deepEqual(copy, valid); assert.notEqual(copy.structure, valid.structure);
  assert.ok(Object.isFrozen(copy.structure) && Object.isFrozen(copy.resources));
});

function native(runId: string): EmitEvent {
  return { name: DEPLOYMENT_EVENT, payload: { version: 1, runId, resourceId: 'a', status: 'ready', action: 'create' },
    timestamp: 1, stageName: 'a', runtimeStageId: 'execute-a#0', pipelineId: 'native-run', subflowPath: [] };
}
test('topology alone establishes no resource readiness and a foreign event cannot use it to turn green', async t => {
  const { recorder: source, engine } = await fixture(t); await engine.apply(graph);
  const chart = source.getSnapshot().chart!, recorder = createDeploymentRecorder();
  recorder.onChart(chart);
  assert.deepEqual(recorder.getSnapshot().resources, {}); assert.deepEqual(recorder.getSnapshot().events, []);
  recorder.onEmit!(native('foreign-run'));
  assert.equal(recorder.getSnapshot().ignoredEvents, 1); assert.deepEqual(recorder.getSnapshot().resources, {});
  recorder.clear!(); assert.equal(recorder.getSnapshot().chart, undefined); assert.equal(recorder.getSnapshot().runId, null);
  assert.throws(() => recorder.subscribeChart(null as never), /subscriber/);
});

test('observer IDs and internal publication recorder identity are admitted explicitly', async t => {
  const { directory } = await fixture(t);
  const store = new FileStateStore(join(directory, 'admission'));
  const observer = { id: 'same', onChart(_chart: DeploymentChart) {} };
  assert.throws(() => new InfraEngine({ adapters: [], store, chartObservers: [observer, observer] }), /Duplicate/);
  assert.throws(() => new InfraEngine({ adapters: [], store, chartObservers: [{ id: 'bad' } as never] }), /onChart/);
  assert.throws(() => new InfraEngine({ adapters: [], store, recorders: [{ id: 'iac-internal-deployment-chart' }] }), /reserved/);
});
