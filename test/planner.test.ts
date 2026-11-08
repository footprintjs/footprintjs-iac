import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan, orderResources } from '../src/planner.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { KubernetesAdapter } from '../src/providers/kubernetes.ts';
import { fingerprint } from '../src/util.ts';
import type { Resource, ResourceAdapter, StackState } from '../src/types.ts';

const resource = (id: string, dependsOn: string[] = [], value = 1): Resource => ({ id, provider: 'simulator', dependsOn, spec: { value } });
const empty = (): StackState => ({ version: 1, stack: 'demo', resources: {} });
const map = (adapter: ResourceAdapter) => new Map([[adapter.name, adapter]]);

test('planner orders dependencies before dependents regardless of declaration order', () => {
  assert.deepEqual(orderResources([resource('app', ['network']), resource('network')]).map(r => r.id), ['network', 'app']);
});

test('planner rejects cycles, missing dependencies, duplicate ids and dangerous ids', () => {
  assert.throws(() => orderResources([resource('a', ['b']), resource('b', ['a'])]), /cycle/);
  assert.throws(() => orderResources([resource('a', ['missing'])]), /Unknown dependency/);
  assert.throws(() => orderResources([resource('a'), resource('a')]), /Duplicate/);
  assert.throws(() => orderResources([resource('__proto__')]), /Invalid resource id/);
});

test('planner refreshes provider observations and distinguishes create, noop, update and readiness verification', async () => {
  const adapter = new SimulatorAdapter();
  const managed = resource('config');
  const stack = { name: 'demo', resources: [managed] };
  assert.equal((await buildPlan(stack, empty(), map(adapter))).operations[0]!.action, 'create');
  await adapter.apply(managed, { stack: 'demo', operationId: 'seed' });
  assert.equal((await buildPlan(stack, empty(), map(adapter))).operations[0]!.action, 'noop');
  await adapter.injectDrift('config', { value: 99 });
  assert.equal((await buildPlan(stack, empty(), map(adapter))).operations[0]!.action, 'update');
  const notReady: ResourceAdapter = {
    name: 'simulator',
    observe: async () => ({ exists: true, owned: true, ready: false, fingerprint: fingerprint(managed.spec) }),
    apply: async () => undefined, remove: async () => undefined, waitReady: async () => undefined,
  };
  assert.equal((await buildPlan(stack, empty(), map(notReady))).operations[0]!.action, 'verify');
});

test('planner still updates omitted previously-managed fields when current desired-field projection matches', async () => {
  const previous = resource('config');
  previous.spec.old = 'remove-me';
  const desired = resource('config');
  const state = empty();
  state.resources.config = { resource: previous, fingerprint: fingerprint(previous.spec) };
  const projectionOnly: ResourceAdapter = {
    name: 'simulator',
    observe: async () => ({ exists: true, owned: true, ready: true, fingerprint: fingerprint(desired.spec) }),
    apply: async () => undefined, remove: async () => undefined, waitReady: async () => undefined,
  };
  assert.equal((await buildPlan({ name: 'demo', resources: [desired] }, state, map(projectionOnly))).operations[0]!.action, 'update');
});

test('planner prunes only when requested and deletes dependents before dependencies', async () => {
  const adapter = new SimulatorAdapter();
  const resources = [resource('network'), resource('app', ['network'])];
  const state = empty();
  for (const item of resources) {
    await adapter.apply(item, { stack: 'demo', operationId: 'seed' });
    state.resources[item.id] = { resource: item, fingerprint: fingerprint(item.spec) };
  }
  const stack = { name: 'demo', resources: [] };
  assert.equal((await buildPlan(stack, state, map(adapter))).operations.length, 0);
  assert.deepEqual((await buildPlan(stack, state, map(adapter), { prune: true })).operations.map(op => [op.resource.id, op.action]), [['app', 'delete'], ['network', 'delete']]);
});

test('planner rejects unknown providers, unowned objects, changed providers and changed API targets', async () => {
  await assert.rejects(buildPlan({ name: 'demo', resources: [resource('a')] }, empty(), new Map()), /Unknown provider/);
  const adapter = new SimulatorAdapter();
  await adapter.apply(resource('a'), { stack: 'someone-else', operationId: 'seed' });
  await assert.rejects(buildPlan({ name: 'demo', resources: [resource('a')] }, empty(), map(adapter)), /unowned/);
  const state = empty();
  state.resources.a = { resource: resource('a'), fingerprint: 'old' };
  await assert.rejects(buildPlan({ name: 'demo', resources: [{ ...resource('a'), provider: 'new-provider' }] }, state, map(adapter)), /Changing provider/);
  const scoped = empty();
  scoped.providerScopes = { simulator: '/another/provider-target' };
  await assert.rejects(buildPlan({ name: 'demo', resources: [] }, scoped, map(adapter)), /Provider target changed/);
});

test('planner rejects changing an existing Kubernetes physical identity', async () => {
  const previous: Resource = { id: 'config', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'before', namespace: 'test' } } };
  const state = empty();
  state.resources.config = { resource: previous, fingerprint: fingerprint(previous.spec) };
  const adapter = new KubernetesAdapter({ context: 'local', runner: async () => { throw new Error('Must validate identity before calling kubectl'); } });
  const changed = { ...previous, spec: { ...previous.spec, metadata: { name: 'after', namespace: 'test' } } };
  await assert.rejects(buildPlan({ name: 'demo', resources: [changed] }, state, map(adapter)), /identity changed/);
});

test('planner rejects two absent Kubernetes resources sharing the same prospective API address', async () => {
  const base: Resource = { id: 'one', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'same', namespace: 'test' } } };
  const adapter = new KubernetesAdapter({ context: 'local', runner: async () => ({ stdout: '' }) });
  await assert.rejects(buildPlan({ name: 'demo', resources: [base, { ...base, id: 'two' }] }, empty(), map(adapter)), /Duplicate physical resource/);
});
