import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileGraph, FileStateStore, InfraEngine, SimulatorAdapter } from '../src/index.ts';
import { createDeploymentRecorder, readDeploymentChart, readDeploymentSchedulePreview } from '../src/progress/index.ts';
import { previewDeploymentChart } from '../src/progress/preview-chart.ts';

const graph = compileGraph({ name: 'preview-chart', boundaries: [], memberships: [], relations: [], resources: [
  { id: 'directory', provider: 'simulator', spec: {} },
  { id: 'space', provider: 'simulator', spec: {} },
  { id: 'app', provider: 'simulator', dependsOn: ['directory', 'space'], spec: {} },
] });

async function fixture(t: { after(fn: () => Promise<void>): void }, maxConcurrency = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-preview-chart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = createDeploymentRecorder(), provider = new SimulatorAdapter();
  let observations = 0;
  const adapter = { name: provider.name, scope: provider.scope, supportsSafeRetry: true,
    observe: (...args: Parameters<typeof provider.observe>) => { observations++; return provider.observe(...args); },
    apply: provider.apply.bind(provider), remove: provider.remove.bind(provider), waitReady: provider.waitReady.bind(provider) };
  const engine = new InfraEngine({ adapters: [adapter], store: new FileStateStore(join(directory, 'state')),
    recorders: [recorder], chartObservers: [recorder], maxConcurrency });
  return { engine, recorder, provider, observations: () => observations };
}

for (const maxConcurrency of [1, 2]) test(`preview uses the unchanged native constructor at concurrency ${maxConcurrency}, without recording or provider calls`, async t => {
  const { engine, recorder, provider, observations } = await fixture(t, maxConcurrency);
  const plan = await engine.plan(graph), before = structuredClone(plan), count = observations();
  const preview = previewDeploymentChart(plan, { maxConcurrency, graphDigest: graph.digest });
  assert.equal(preview.kind, 'deployment-schedule-preview');
  assert.equal(preview.stack, graph.name); assert.equal(preview.graphDigest, graph.digest);
  assert.equal('runId' in preview, false); assert.equal('events' in preview, false); assert.equal('status' in preview, false);
  assert.equal(observations(), count, 'a preview must not contact the provider');
  assert.deepEqual(provider.calls, []); assert.equal(recorder.getSnapshot().runId, null);
  assert.deepEqual(recorder.getSnapshot().events, []); assert.equal(recorder.getSnapshot().chart, undefined);
  assert.deepEqual(plan, before, 'the supplied plan remains unchanged');
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.structure) && Object.isFrozen(preview.resources));
  const result = await engine.apply(graph);
  assert.equal(result.ok, true);
  const actual = recorder.getSnapshot().chart!;
  assert.deepEqual(preview.structure, actual.structure, 'the observed native topology has exactly the preview positions');
  assert.deepEqual(preview.resources, actual.resources.map(({ schedule, ...binding }) => binding));
  assert.equal(actual.runId, result.runId);
  assert.notEqual(actual.runId, 'schedule-preview');
  assert.deepEqual(preview.resources.map(resource => resource.batchIndex), maxConcurrency === 1 ? [0, 1, 2] : [0, 0, 1]);
});

test('no-op and pruning previews retain the actual planned actions and serial deletion order', async t => {
  const { engine, recorder } = await fixture(t, 2);
  await engine.apply(graph);
  const noop = previewDeploymentChart(await engine.plan(graph), { maxConcurrency: 2, graphDigest: graph.digest });
  assert.ok(noop.resources.every(resource => resource.action === 'noop'));
  await engine.apply(graph);
  assert.deepEqual(noop.resources, recorder.getSnapshot().chart!.resources.map(({ schedule, ...binding }) => binding));
  const smaller = compileGraph({ name: graph.name, boundaries: [], memberships: [], relations: [],
    resources: graph.resources.filter(resource => resource.id === 'directory') });
  const plan = await engine.plan(smaller, { prune: true });
  const preview = previewDeploymentChart(plan, { maxConcurrency: 2, graphDigest: smaller.digest });
  assert.deepEqual(preview.resources.filter(resource => resource.action === 'delete').map(resource => resource.resourceId), ['app', 'space']);
  const result = await engine.apply(smaller, { prune: true });
  assert.equal(result.ok, true);
  assert.deepEqual(preview.structure, recorder.getSnapshot().chart!.structure);
  assert.deepEqual(preview.resources, recorder.getSnapshot().chart!.resources.map(({ schedule, ...binding }) => binding));
});

test('preview admission rejects fake run state, accessors and invalid native mappings without executing getters', async t => {
  const { engine } = await fixture(t);
  const plan = await engine.plan(graph), preview = previewDeploymentChart(plan, { graphDigest: graph.digest });
  const read = readDeploymentSchedulePreview(JSON.parse(JSON.stringify(preview)));
  assert.deepEqual(read, preview); assert.notEqual(read.structure, preview.structure);
  assert.throws(() => readDeploymentChart(preview), /property/);
  let invoked = false;
  const accessorPlan = { ...plan, get operations() { invoked = true; return plan.operations; } };
  assert.throws(() => previewDeploymentChart(accessorPlan)); assert.equal(invoked, false);
  const accessorPreview = { ...preview, get structure() { invoked = true; return preview.structure; } };
  assert.throws(() => readDeploymentSchedulePreview(accessorPreview), /property/); assert.equal(invoked, false);
  for (const invalid of [
    { ...preview, runId: 'pretend-run' }, { ...preview, events: [] }, { ...preview, status: 'ready' },
    { ...preview, kind: 'deployment-chart' }, { ...preview, graphDigest: 'wrong' },
    { ...preview, resources: [{ ...preview.resources[0], executeStageId: 'absent' }] },
  ]) assert.throws(() => readDeploymentSchedulePreview(invalid));
  assert.throws(() => previewDeploymentChart(plan, { maxConcurrency: 0 }));
  assert.throws(() => previewDeploymentChart(plan, { graphDigest: 'wrong' }));
});
