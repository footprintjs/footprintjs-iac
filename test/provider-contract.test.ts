import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FileStateStore, InfraEngine, ProviderChangeError, canonical, fingerprint, project, resourceAttribute } from '../src/core.ts';
import { compileGraph } from '../src/graph/index.ts';
import { fingerprintPlan } from '../src/master/index.ts';
import { previewDeploymentChart } from '../src/progress/preview-chart.ts';
import type { JsonObject, Resource, ResourceAdapter } from '../src/types.ts';

const producer = { id: 'source', provider: 'generated', spec: { label: 'queue' } };
const consumer = { id: 'sink', provider: 'generated', dependsOn: ['source'],
  spec: { queue: resourceAttribute('source', 'url'), filters: [resourceAttribute('source', 'filter')] } };
const stack = { name: 'provider-ports', resources: [consumer, producer] };

async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'iac-provider-contract-'));
  t.after(() => rm(folder, { recursive: true }));
  const store = new FileStateStore(folder);
  const records = new Map<string, { resource: Resource; attributes?: JsonObject }>();
  const effects: string[] = [];
  const observations: string[] = [];
  let counter = 0;
  const adapter: ResourceAdapter = {
    name: 'generated',
    async observe(resource, context) {
      observations.push(resource.id);
      const row = context.physicalId ? records.get(context.physicalId) : undefined;
      if (!row) return { exists: false };
      return { exists: true, owned: row.resource.id === resource.id, ready: true,
        physicalId: context.physicalId, fingerprint: fingerprint(project(row.resource.spec, resource.spec)),
        ...(row.attributes && { attributes: row.attributes }) };
    },
    async apply(resource, context) {
      const id = context.physicalId ?? 'provider-generated-' + ++counter;
      effects.push('apply:' + resource.id);
      // The apply receipt is the only lookup method for a first creation.
      records.set(id, { resource: structuredClone(resource), ...(resource.id === 'source' && {
        attributes: { url: 'queue://' + id, filter: { status: 'open' } },
      }) });
      return { physicalId: id };
    },
    async waitReady(resource, context) {
      assert.ok(context.physicalId && records.has(context.physicalId));
      assert.equal((await store.load(stack.name)).resources[resource.id]?.physicalId, context.physicalId);
    },
    async remove(resource, context) {
      effects.push('delete:' + resource.id);
      assert.ok(context.physicalId && records.delete(context.physicalId));
    },
  };
  return { store, records, adapter, effects, observations, engine: new InfraEngine({ store, adapters: [adapter], maxConcurrency: 3 }) };
}

test('provider ports hash concrete specs, checkpoint generated IDs and resolve verified dependency attributes', async t => {
  const { engine, store, records, effects } = await fixture(t);
  assert.equal(canonical({ z: 1, a: null }), '{"a":null,"z":1}');
  const graph = compileGraph({ ...stack, boundaries: [], memberships: [], relations: [] });
  const plan = await engine.plan(graph);
  assert.deepEqual(plan.operations.map(row => [row.resource.id, row.action, row.inputResolution]), [
    ['source', 'create', undefined], ['sink', 'create', { deferred: true }],
  ]);
  assert.deepEqual(previewDeploymentChart(plan).resources.map(row => row.resourceId), ['source', 'sink']);
  const first = await engine.apply(graph, { expectedPlanDigest: fingerprintPlan(plan) });
  assert.equal(first.ok, true, first.failure?.message);
  const state = await store.load(graph.name);
  assert.equal(state.resources.source!.physicalId, 'provider-generated-1');
  assert.deepEqual(state.resources.source!.attributes, { url: 'queue://provider-generated-1', filter: { status: 'open' } });
  const concrete = { queue: 'queue://provider-generated-1', filters: [{ status: 'open' }] };
  assert.deepEqual(records.get('provider-generated-2')?.resource.spec, concrete);
  assert.equal(state.resources.sink!.fingerprint, fingerprint(concrete));
  const stable = await engine.plan(graph);
  assert.deepEqual(stable.operations.map(row => [row.action, row.inputResolution]), [['noop', undefined], ['noop', { spec: concrete }]]);
  assert.equal((await engine.apply(graph, { expectedPlanDigest: fingerprintPlan(stable) })).ok, true);
  assert.deepEqual(effects, ['apply:source', 'apply:sink']);
  const removed = await engine.apply({ name: stack.name, resources: [] }, { prune: true });
  assert.equal(removed.ok, true);
  assert.deepEqual(effects.slice(2), ['delete:sink', 'delete:source']);
});

test('a known replacement or rejection from any adapter blocks planning before observations', async t => {
  const fixtureState = await fixture(t);
  const { engine, adapter, observations, effects } = fixtureState;
  assert.equal((await engine.apply({ ...stack, resources: [producer] })).ok, true);
  const desired = { ...stack, resources: [{ ...producer, spec: { label: 'another-queue' } }] };
  for (const disposition of ['replace', 'reject'] as const) {
    adapter.assessChange = (before, after) => {
      assert.equal(before.spec.label, 'queue');
      assert.equal(after.spec.label, 'another-queue');
      return { disposition, reason: 'This queue name cannot be changed in place.' };
    };
    const count = observations.length;
    await assert.rejects(engine.plan(desired), error => error instanceof ProviderChangeError && error.disposition === disposition);
    assert.equal(observations.length, count);
  }
  assert.deepEqual(effects, ['apply:source']);
  adapter.assessChange = () => ({ disposition: 'update' });
  assert.equal((await engine.plan(desired)).operations[0]!.action, 'update');
});

test('unpublished or undeclared outputs cannot be passed to the dependent adapter', async t => {
  const { engine, effects, observations } = await fixture(t);
  await assert.rejects(engine.plan({ ...stack, resources: [producer, { ...consumer, dependsOn: [] }] }), /must depend directly/);
  assert.equal(observations.length, 0);
  const missing = { ...consumer, spec: { queue: resourceAttribute('source', 'missing') } };
  const result = await engine.apply({ ...stack, resources: [producer, missing] });
  assert.equal(result.ok, false);
  assert.match(result.failure!.message, /did not publish attribute missing/);
  assert.deepEqual(effects, ['apply:source']);
  assert.ok(!observations.includes('sink'));
});

test('an attribute changing after review cannot silently update its consumer', async t => {
  const { engine, adapter, effects } = await fixture(t);
  assert.equal((await engine.apply(stack)).ok, true);
  const observe = adapter.observe.bind(adapter);
  adapter.observe = async (resource, context) => {
    const result = await observe(resource, context);
    if (resource.id === 'source' && context.operationId !== 'plan' && result.attributes) {
      result.attributes = { ...result.attributes, url: 'queue://changed-after-review' };
    }
    return result;
  };
  const plan = await engine.plan(stack);
  const result = await engine.apply(stack, { expectedPlanDigest: fingerprintPlan(plan) });
  assert.equal(result.ok, false);
  assert.match(result.failure!.message, /changed after planning/);
  assert.deepEqual(effects, ['apply:source', 'apply:sink']);
});
