import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { system, artifact, ref } from '../src/system/index.ts';
import { bindSystem, simulationProfile } from '../src/binding/index.ts';
import type { BindingProfile, CapabilityAdapter } from '../src/binding/index.ts';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { readInfraGraph } from '../src/graph/validation.ts';
import { fingerprint } from '../src/util.ts';
import type { JsonObject } from '../src/types.ts';

const artifacts = { 'api-program': { executable: 'fixture-api', version: 1 } };
function profile(): BindingProfile { return simulationProfile({ artifacts }); }
function fixture(group = 'state', retain: boolean | null = true) {
  return system('binding-test')
    .addNetwork('network', network => network.addSegment('backend'))
    .addStorage(group, storage => storage
      .addSessionStore('sessions', store => {
        store.sharing('shared').durability('persistent').expiration({ idle: '30m' }).replication({ copies: 2 });
        if (retain !== null) store.retainOnRemoval(retain);
      }))
    .addCompute('application', compute => compute.addService('api', service => service.program(artifact('api-program'))
      .useNetwork(ref.network('network.backend')).useStorage(ref.store(group + '.sessions'), { access: 'readWrite' })))
    .boundary({ id: 'data-review', kind: 'security', attributes: { enforcement: 'descriptive-only' } })
    .within('data-review', ref.store(group + '.sessions'), ref.service('application.api'))
    .build();
}
function custom(adapter: Partial<CapabilityAdapter>): BindingProfile {
  const base = profile();
  return { ...base, adapters: [{ ...base.adapters[0]!, ...adapter }] };
}
async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SimulatorAdapter();
  const store = new FileStateStore(directory);
  const engine = new InfraEngine({ adapters: [provider], store, maxConcurrency: 2 });
  return { provider, store, engine };
}

test('binding is deterministic, immutable, inspectable and keeps complete simulated support claims', () => {
  const design = fixture();
  const bound = bindSystem(design, profile());
  assert.deepEqual(bound, bindSystem(design, profile()));
  assert.equal(bound.kind, 'system-binding');
  assert.equal(bound.designDigest, design.digest);
  assert.ok(Object.isFrozen(bound) && Object.isFrozen(bound.graph.resources[0]!.spec));
  assert.deepEqual(readInfraGraph(JSON.parse(JSON.stringify(bound.graph))), bound.graph);
  const { digest, ...body } = bound;
  assert.equal(digest, fingerprint(body));
  for (const capability of design.capabilities) {
    const decision = bound.decisions.find(row => row.capabilityId === capability.id)!;
    assert.equal(decision.status, 'simulated');
    assert.deepEqual(decision.requirements.map(row => row.property), Object.keys(capability.properties).sort());
    assert.ok(decision.requirements.every(row => row.status === 'simulated'));
    assert.equal(decision.candidates.filter(row => row.matched).length, 1);
    const mapping = bound.mappings.find(row => row.capabilityId === capability.id)!;
    const origin = bound.graph.boundaries.find(row => row.id === mapping.groupId)!;
    assert.equal(origin.kind, 'group');
    assert.equal(origin.attributes?.designDigest, design.digest);
    assert.equal(origin.attributes?.capabilityPath, capability.path);
    assert.equal(origin.attributes?.mode, 'simulation');
  }
});

test('multi-resource storage dependencies and descriptive boundary memberships expand across the graph', () => {
  const bound = bindSystem(fixture(), profile());
  const store = bound.mappings.find(row => row.capabilityId === 'sessions')!;
  const api = bound.mappings.find(row => row.capabilityId === 'api')!;
  assert.equal(store.resourceIds.length, 3);
  assert.equal(store.entryPoints.length, 1);
  assert.equal(store.exitPoints.length, 2);
  for (const id of api.entryPoints) for (const dependency of store.exitPoints) {
    assert.ok(bound.graph.resources.find(row => row.id === id)!.dependsOn!.includes(dependency));
  }
  for (const id of [...store.resourceIds, ...api.resourceIds]) {
    assert.ok(bound.graph.memberships.some(row => row.resourceId === id && row.boundaryId === 'data-review'));
  }
  assert.equal(bound.graph.boundaries.find(row => row.id === 'data-review')!.attributes!.enforcement, 'descriptive-only');
  for (const id of store.exitPoints) assert.ok(bound.graph.relations.some(row => row.from === api.exitPoints[0] && row.to === id && row.kind === 'communicatesWith'));
  assert.ok(!bound.graph.relations.some(row => row.from === api.exitPoints[0] && row.to === store.entryPoints[0] && row.kind === 'communicatesWith'));
  assert.ok(!bound.graph.resources.find(row => row.id === store.entryPoints[0])!.dependsOn?.includes(api.exitPoints[0]!));
});

test('target identity changes addresses while a profile display ID change preserves addresses', () => {
  const design = fixture();
  const first = bindSystem(design, profile());
  const renamed = bindSystem(design, { ...profile(), id: 'renamed-profile' });
  const moved = bindSystem(design, simulationProfile({ targetId: 'other-target', artifacts }));
  const ids = (bound: typeof first) => bound.graph.resources.map(row => row.id);
  assert.deepEqual(ids(first), ids(renamed));
  assert.notDeepEqual(ids(first), ids(moved));
  assert.ok(moved.graph.resources.every(row => (row.spec.bindingTarget as JsonObject).id === 'other-target'));
  assert.notEqual(first.digest, renamed.digest);
});

test('regrouping stable capability IDs and references is a real engine noop', async t => {
  const { provider, engine } = await harness(t);
  const first = bindSystem(fixture('original'), profile());
  const regrouped = bindSystem(fixture('renamed'), profile());
  assert.deepEqual(first.graph.resources, regrouped.graph.resources);
  assert.notEqual(first.designDigest, regrouped.designDigest);
  assert.equal((await engine.apply(first.graph)).ok, true);
  const calls = provider.calls.length;
  assert.ok((await engine.plan(regrouped.graph)).operations.every(row => row.action === 'noop'));
  assert.equal((await engine.apply(regrouped.graph)).ok, true);
  assert.equal(provider.calls.length, calls);
});

test('retainOnRemoval is operational lifecycle metadata and release causes zero provider writes', async t => {
  const { provider, engine, store } = await harness(t);
  const retained = bindSystem(fixture('state', true), profile());
  const released = bindSystem(fixture('state', false), profile());
  assert.deepEqual(retained.graph.resources.map(row => row.spec), released.graph.resources.map(row => row.spec));
  assert.equal((await engine.apply(retained.graph)).ok, true);
  const calls = provider.calls.length;
  assert.ok((await engine.plan(released.graph)).operations.every(row => row.action === 'noop'));
  assert.equal((await engine.apply(released.graph)).ok, true);
  assert.equal(provider.calls.length, calls);
  const exits = released.mappings.find(row => row.capabilityId === 'sessions')!.exitPoints;
  const saved = await store.load(released.graph.name);
  for (const id of exits) assert.deepEqual(saved.resources[id]!.resource.lifecycle, { retainOnRemoval: false });
  assert.equal((await engine.plan({ name: released.graph.name, resources: [] }, { prune: true })).retained, undefined);
});

test('retained bound storage protects its internal dependency closure during actual prune', async t => {
  const { engine, provider } = await harness(t);
  const bound = bindSystem(fixture(), profile());
  assert.equal((await engine.apply(bound.graph)).ok, true);
  const mapping = bound.mappings.find(row => row.capabilityId === 'sessions')!;
  const pruned = await engine.apply({ name: bound.graph.name, resources: [] }, { prune: true });
  assert.equal(pruned.ok, true);
  assert.deepEqual(pruned.plan.retained?.map(row => row.resourceId).sort(), [...mapping.resourceIds].sort());
  assert.ok(mapping.resourceIds.every(id => !provider.calls.some(row => row.id === id && row.action === 'delete')));
  assert.ok(pruned.plan.retained?.some(row => row.reason === 'dependency'));
  const absent = bindSystem(fixture('state', null), profile());
  assert.ok(absent.graph.resources.every(row => row.lifecycle === undefined));
});

test('profile options detach caller JSON and reject accessors without executing them', () => {
  const input = { 'api-program': { executable: 'original' } };
  const result = simulationProfile({ artifacts: input });
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input['api-program']), false);
  input['api-program'].executable = 'changed';
  assert.equal(result.artifacts['api-program']!.executable, 'original');
  let getters = 0;
  const getterArtifacts = Object.defineProperty({}, 'api-program', { enumerable: true, get() { getters++; return {}; } });
  assert.throws(() => simulationProfile({ artifacts: getterArtifacts }), /accessor|JSON/);
  const options = Object.defineProperty({}, 'artifacts', { enumerable: true, get() { getters++; return {}; } });
  assert.throws(() => simulationProfile(options as { artifacts: Record<string, JsonObject> }), /accessor/);
  assert.equal(getters, 0);
  assert.throws(() => simulationProfile({ artifacts: {}, unexpected: true } as never), /Unknown/);
});

test('missing artifacts, unknown requirements and unsupported principal claims fail before lowering', () => {
  let lowered = 0;
  const base = profile().adapters[0]!;
  const counted = custom({ lower(capability, context) { lowered++; return base.lower(capability, context); } });
  assert.throws(() => bindSystem(fixture(), { ...counted, artifacts: {} }), /Unsupported.*api/);
  const purpose = system('purpose').addCompute('app', c => c.addService('api', s => s.program(artifact('api-program')).purpose('unmodeled-purpose'))).build();
  assert.throws(() => bindSystem(purpose, counted), /purpose/);
  const permissions = system('permissions').principal('runtime', { permissions: ['root'] })
    .addCompute('app', c => c.addService('api', s => s.program(artifact('api-program')).runAs(ref.principal('runtime')))).build();
  assert.throws(() => bindSystem(permissions, counted), /runAs/);
  assert.equal(lowered, 0);
});

test('selection rejects ambiguity and no-match; nested property rule values match exactly', () => {
  const base = profile();
  assert.throws(() => bindSystem(fixture(), { ...base, rules: base.rules.filter(rule => rule.family !== 'compute') }), /No.*adapter|No.*rule/i);
  assert.throws(() => bindSystem(fixture(), { ...base, rules: [...base.rules, { ...base.rules[0]!, id: 'duplicate-choice' }] }), /Ambiguous/);
  const rules = base.rules.map(rule => rule.family === 'storage'
    ? { ...rule, properties: { expiration: { idle: '30m' } } } : rule);
  assert.ok(bindSystem(fixture(), { ...base, rules }));
  const near = rules.map(rule => rule.family === 'storage' ? { ...rule, properties: { expiration: {} } } : rule);
  assert.throws(() => bindSystem(fixture(), { ...base, rules: near }), /No.*adapter|No.*rule/i);
});

test('required boundary enforcement rejects before any adapter callback', () => {
  let called = 0;
  const design = system('required').addNetwork('net', n => n.addSegment('segment'))
    .boundary({ id: 'private', kind: 'security', requirements: [{ kind: 'isolation', mode: 'required' }] })
    .within('private', ref.network('net.segment')).build();
  assert.throws(() => bindSystem(design, custom({ supports() { called++; throw new Error('Must not run'); } })), /Unsupported required boundary enforcement/);
  assert.equal(called, 0);
});

test('async, Promise and thenable callbacks cannot be admitted as pure compilation', () => {
  let asyncCalled = false;
  const asynchronous = (async () => { asyncCalled = true; return {}; }) as unknown as CapabilityAdapter['supports'];
  assert.throws(() => bindSystem(fixture(), custom({ supports: asynchronous })), /synchronous/);
  assert.equal(asyncCalled, false);
  const promise = (() => Promise.resolve({})) as unknown as CapabilityAdapter['supports'];
  assert.throws(() => bindSystem(fixture(), custom({ supports: promise })), /Promise/);
  let getter = false;
  const thenable = (() => Object.defineProperty({}, 'then', { get() { getter = true; return () => {}; } })) as unknown as CapabilityAdapter['supports'];
  assert.throws(() => bindSystem(fixture(), custom({ supports: thenable })), /thenable/);
  assert.equal(getter, false);
});

test('every exact declared property needs a support claim, and verified claims are rejected', () => {
  const base = profile().adapters[0]!;
  assert.throws(() => bindSystem(fixture(), custom({ supports(cap, ctx) {
    const support = base.supports(cap, ctx); return { ...support, requirements: [] };
  } })), /silently omitted/);
  assert.throws(() => bindSystem(fixture(), custom({ supports(cap, ctx) {
    const support = base.supports(cap, ctx);
    return { ...support, requirements: support.requirements.map(row => ({ ...row, requested: 'different' })) };
  } })), /differs/);
  assert.throws(() => bindSystem(fixture(), custom({ supports(cap, ctx) {
    const support = base.supports(cap, ctx);
    return { ...support, requirements: support.requirements.map(row => ({ ...row, status: 'verified' as never })) };
  } })), /not verified/);
});

test('lowering rejects unallocated IDs, cross-capability edges, cycles and simulation/provider mode mismatch', () => {
  assert.throws(() => bindSystem(fixture(), custom({ lower() { return { resources: [{ id: 'arbitrary', provider: 'simulator', spec: {} }] }; } })), /context.resourceId/);
  assert.throws(() => bindSystem(fixture(), custom({ lower(_cap, ctx) {
    return { resources: [{ id: ctx.resourceId(), provider: 'simulator', spec: {}, dependsOn: ['somewhere-else'] }] };
  } })), /within their capability/);
  assert.throws(() => bindSystem(fixture(), custom({ lower(_cap, ctx) {
    const a = ctx.resourceId('a'), b = ctx.resourceId('b');
    return { resources: [{ id: a, provider: 'simulator', spec: {}, dependsOn: [b] }, { id: b, provider: 'simulator', spec: {}, dependsOn: [a] }] };
  } })), /cycle/i);
  assert.throws(() => bindSystem(fixture(), custom({ lower(_cap, ctx) {
    return { resources: [{ id: ctx.resourceId(), provider: 'kubernetes', spec: {} }] };
  } })), /mode.*provider/);
});

test('storage retain claims must become actual lifecycle intent on every data exit', () => {
  assert.throws(() => bindSystem(fixture(), custom({ lower(_cap, ctx) {
    return { resources: [{ id: ctx.resourceId(), provider: 'simulator', spec: {} }] };
  } })), /retention must lower/);
});

test('architecture targets logical terminal resources while deployment dependencies target setup entries', () => {
  const design = system('terminal-projection')
    .addStorage('state', storage => storage.addStore('history', store => store.durability('ephemeral')))
    .addCompute('app', compute => compute.addService('api', service => service.program(artifact('api-program'))
      .useStorage(ref.store('state.history'), { access: 'readWrite' })))
    .addNetwork('public', network => network.addEndpoint('http', endpoint => endpoint.protocol('http').port(5230).target(ref.service('app.api'))))
    .build();
  const base = profile().adapters[0]!;
  const bound = bindSystem(design, custom({ lower(capability, context) {
    if (capability.family !== 'compute') return base.lower(capability, context);
    const entry = context.resourceId('setup'), exit = context.resourceId('runtime');
    return { resources: [
      { id: entry, provider: 'simulator', spec: { role: 'setup' } },
      { id: exit, provider: 'simulator', spec: { role: 'runtime' }, dependsOn: [entry] },
    ] };
  } }));
  const api = bound.mappings.find(row => row.capabilityId === 'api')!;
  const store = bound.mappings.find(row => row.capabilityId === 'history')!;
  const endpoint = bound.mappings.find(row => row.capabilityId === 'http')!;
  assert.notDeepEqual(api.entryPoints, api.exitPoints);
  for (const dependency of store.exitPoints) {
    assert.ok(bound.graph.resources.find(row => row.id === api.entryPoints[0])!.dependsOn!.includes(dependency));
    assert.ok(bound.graph.relations.some(edge => edge.from === api.exitPoints[0] && edge.to === dependency && edge.kind === 'communicatesWith'));
  }
  assert.ok(bound.graph.relations.some(edge => edge.from === endpoint.exitPoints[0] && edge.to === api.exitPoints[0] && edge.kind === 'communicatesWith'));
  assert.ok(!bound.graph.relations.some(edge => edge.from === endpoint.exitPoints[0] && edge.to === api.entryPoints[0] && edge.kind === 'communicatesWith'));
  assert.ok(bound.graph.resources.find(row => row.id === endpoint.entryPoints[0])!.dependsOn!.includes(api.exitPoints[0]!));
});
