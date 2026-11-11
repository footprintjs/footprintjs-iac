import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { applyNeoIdentityFault, createIdentityGraph } from '../integration/identity/index.ts';
import { createNeoIdentityFaultGraph, type NeoIdentityFaultAction } from '../integration/identity/fault-graph.ts';
import { executeNeoIdentityFaultEffect } from '../integration/identity/fault-effect.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { FileStateStore } from '../src/store.ts';
import type { Resource, ResourceAdapter, StackState, StateStore } from '../src/types.ts';
import { fingerprint } from '../src/util.ts';

async function fixture(t: { after(callback: () => Promise<unknown>): void }) {
  const base = await mkdtemp(join(tmpdir(), 'identity-faults-')), root = join(base, '.artifacts/identity'), id = 'a1b2c3d4';
  t.after(() => rm(base, { recursive: true, force: true }));
  const target: IdentityTarget = { version: 1, id, directory: resolve(root, id), stateDirectory: resolve(root, id, 'state'),
    context: 'kind-footprint-iac-recording-b1b2c3d4', namespace: `footprint-iac-identity-${id}`,
    kubeconfig: resolve(root, '../..', '.artifacts/neo/fresh/b1b2c3d4/kubeconfig'), neoPort: 15230, providerPort: 15231, ldapPort: 15232,
    issuer: 'http://127.0.0.1:15231/realms/neo', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
    fixtureDigest: 'a'.repeat(64), providerAddress: '172.18.0.5', images: { nodeImage: 'sha256:' + '1'.repeat(64), pythonImage: 'sha256:' + '2'.repeat(64),
      ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  const graph = createIdentityGraph(target, { includeNeo: true }), store = new FileStateStore(target.stateDirectory);
  const state: StackState = { version: 1, stack: graph.name, resources: Object.fromEntries(graph.resources.map(resource => [resource.id,
    { resource, fingerprint: fingerprint(resource.spec), physicalId: `owned:${resource.id}` }])) };
  await store.save(state);
  const live = new Map(graph.resources.map(resource => [resource.id, structuredClone(resource)])), mutations: string[] = [];
  let sealed = true;
  const adapters = ['kubernetes', 'local-identity-fixture'].map((name): ResourceAdapter => ({ name, supportsSafeRetry: true,
    async observe(resource) { const actual = live.get(resource.id); return actual ? { exists: true, owned: true, ready: true,
      physicalId: `owned:${resource.id}`, fingerprint: fingerprint(actual.spec) } : { exists: false }; },
    async apply(resource) { mutations.push(resource.id); live.set(resource.id, structuredClone(resource)); },
    async remove() { throw Error('Fault tests may not delete'); }, async waitReady() {},
  }));
  const options = { fixtureRoot: root, loadTarget: async () => ({ ...target, fixtureDigest: sealed ? target.fixtureDigest : 'f'.repeat(64) }), adapters, store };
  return { target, graph, state, store, live, mutations, options, invalidate() { sealed = false; } };
}
const routePort = (resource: Resource) => (resource.spec.spec as any).ports[0].targetPort;

test('fault reconciliation changes only the selected owned field and durably records outage and restoration', async t => {
  const f = await fixture(t);
  for (const [down, restore, id] of [
    ['directory-down', 'directory-restore', 'identity-directory'], ['provider-down', 'provider-restore', 'identity-provider'],
    ['service-route-down', 'service-route-restore', 'neo-service'],
  ] as const) {
    const first = f.mutations.length, outage = await applyNeoIdentityFault(f.target, down, f.options);
    assert.equal(outage.result.ok, true, JSON.stringify(outage.result.failure)); assert.deepEqual(f.mutations.slice(first), [id]);
    assert.equal(id === 'neo-service' ? routePort(f.live.get(id)!) : f.live.get(id)!.spec.enabled, id === 'neo-service' ? 5999 : false);
    assert.ok(outage.events.some(event => event.resourceId === id && event.status === 'ready'));
    const evidence = JSON.parse(await readFile(join(f.target.directory, 'faults', outage.result.runId + '.json'), 'utf8'));
    assert.equal(evidence.action, down); assert.equal(evidence.resourceId, id); assert.ok(evidence.result.evidencePath);
    assert.equal((await applyNeoIdentityFault(f.target, restore, f.options)).result.ok, true);
    assert.equal(id === 'neo-service' ? routePort(f.live.get(id)!) : f.live.get(id)!.spec.enabled, id === 'neo-service' ? 'http' : true);
  }
});

test('supported nested faults preserve one another, and restoration only changes its selected resource', async t => {
  const f = await fixture(t);
  for (const action of ['directory-down', 'provider-down', 'service-route-down'] as const) { const result = await applyNeoIdentityFault(f.target, action, f.options); assert.equal(result.result.ok, true, JSON.stringify(result.result.failure)); }
  assert.deepEqual(f.mutations, ['identity-directory', 'identity-provider', 'neo-service']);
  assert.equal((await applyNeoIdentityFault(f.target, 'provider-restore', f.options)).result.ok, true);
  assert.equal(f.live.get('identity-directory')!.spec.enabled, false); assert.equal(routePort(f.live.get('neo-service')!), 5999);
});

test('fault graph refuses partial, unresolved, substituted and foreign durable inventories', async t => {
  const f = await fixture(t);
  for (const change of [
    (state: StackState) => { delete state.resources['neo-service']; },
    (state: StackState) => { state.stack = 'foreign'; },
    (state: StackState) => { state.resources['neo-app']!.pending = { operationId: 'uncertain', action: 'update', desiredFingerprint: 'x' }; },
    (state: StackState) => { delete state.resources['identity-provider']!.physicalId; },
    (state: StackState) => { const saved = state.resources['neo-app']!; saved.resource.spec.foreign = true; saved.fingerprint = fingerprint(saved.resource.spec); },
    (state: StackState) => { const saved = state.resources['neo-service']!; (saved.resource.spec.spec as any).ports[0].targetPort = 6000; saved.fingerprint = fingerprint(saved.resource.spec); },
  ]) { const state = structuredClone(f.state); change(state); assert.throws(() => createNeoIdentityFaultGraph(f.target, state, 'provider-down')); }
  assert.throws(() => createNeoIdentityFaultGraph(f.target, f.state, 'arbitrary' as NeoIdentityFaultAction));
});

test('fault admission rejects changed targets, unrelated drift and replacement before any provider mutation', async t => {
  const f = await fixture(t); f.invalidate();
  await assert.rejects(applyNeoIdentityFault(f.target, 'provider-down', f.options), /admission/); assert.equal(f.mutations.length, 0);
  const drift = await fixture(t); drift.live.get('neo-access-policy')!.spec.data = { changed: true };
  await assert.rejects(applyNeoIdentityFault(drift.target, 'provider-down', drift.options), /unrelated/); assert.equal(drift.mutations.length, 0);
  const absent = await fixture(t); absent.live.delete('identity-provider');
  await assert.rejects(applyNeoIdentityFault(absent.target, 'provider-down', absent.options), /replacements/); assert.equal(absent.mutations.length, 0);
});

test('inventory changes before the execution lock and new unrelated repairs inside it are blocked', async t => {
  const f = await fixture(t);
  const racingStore: StateStore = { load: f.store.load.bind(f.store), save: f.store.save.bind(f.store), append: f.store.append.bind(f.store), saveEvidence: f.store.saveEvidence.bind(f.store),
    withLock: (name, work) => f.store.withLock(name, async () => {
      const changed = await f.store.load(name); changed.providerScopes = { foreign: 'target' }; await f.store.save(changed); return work();
    }) };
  await assert.rejects(applyNeoIdentityFault(f.target, 'provider-down', { ...f.options, store: racingStore }), /inventory changed/);
  assert.equal(f.mutations.length, 0);
  const drift = await fixture(t);
  const lateDrift: StateStore = { load: drift.store.load.bind(drift.store), save: drift.store.save.bind(drift.store), append: drift.store.append.bind(drift.store), saveEvidence: drift.store.saveEvidence.bind(drift.store),
    withLock: (name, work) => drift.store.withLock(name, async () => { drift.live.get('neo-access-policy')!.spec.data = { changed: true }; return work(); }) };
  const result = await applyNeoIdentityFault(drift.target, 'provider-down', { ...drift.options, store: lateDrift });
  assert.equal(result.result.ok, false); assert.ok(drift.mutations.every(id => id === 'identity-provider'));
  const absent = await fixture(t);
  const disappeared: StateStore = { load: absent.store.load.bind(absent.store), save: absent.store.save.bind(absent.store), append: absent.store.append.bind(absent.store), saveEvidence: absent.store.saveEvidence.bind(absent.store),
    withLock: (name, work) => absent.store.withLock(name, async () => { absent.live.delete('identity-provider'); return work(); }) };
  assert.equal((await applyNeoIdentityFault(absent.target, 'provider-down', { ...absent.options, store: disappeared })).result.ok, false);
  assert.equal(absent.mutations.length, 0);
});

test('real fault command construction only starts/stops exact containers or conditionally patches the existing Service port', async t => {
  const f = await fixture(t), context = { stack: f.graph.name, operationId: 'owned-fault-test' };
  const selected = createNeoIdentityFaultGraph(f.target, f.state, 'service-route-down').graph.resources.find(resource => resource.id === 'neo-service')!;
  const live: any = structuredClone(f.graph.resources.find(resource => resource.id === 'neo-service')!.spec);
  live.metadata = { ...live.metadata, uid: 'service-uid', resourceVersion: '7', annotations: {
    'footprint-iac.dev/owner': fingerprint({ stack: f.graph.name, id: 'neo-service' }), 'footprint-iac.dev/stack': f.graph.name, 'footprint-iac.dev/resource': 'neo-service' } };
  const calls: { command: string; args: string[]; timeout: number }[] = [];
  const runner = async (command: string, args: string[], timeout = 30000) => { calls.push({ command, args, timeout }); return args.includes('get') ? JSON.stringify(live) : ''; };
  await executeNeoIdentityFaultEffect(f.target, selected, 'owned:neo-service', context, runner);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !['create', 'apply', 'delete', 'sh'].some(value => call.args.includes(value))));
  const args = calls[1]!.args, patch = JSON.parse(args[args.indexOf('--patch') + 1]!);
  assert.deepEqual(patch.slice(0, 2), [{ op: 'test', path: '/metadata/uid', value: 'service-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: '7' }]);
  assert.deepEqual(patch.at(-1), { op: 'replace', path: '/spec/ports/0/targetPort', value: 5999 });
  live.metadata.annotations['footprint-iac.dev/owner'] = 'foreign';
  await assert.rejects(executeNeoIdentityFaultEffect(f.target, selected, 'owned:neo-service', context, runner), /ownership changed/);
  assert.equal(calls.length, 3);
  const provider = createNeoIdentityFaultGraph(f.target, f.state, 'provider-down').graph.resources.find(resource => resource.id === 'identity-provider')!;
  await executeNeoIdentityFaultEffect(f.target, provider, 'c'.repeat(64), context, runner);
  assert.deepEqual(calls.at(-1), { command: 'docker', args: ['stop', 'c'.repeat(64)], timeout: 30000 });
});
