import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { identityCleanupStack } from '../integration/identity/cleanup-plan.ts';
import { createIdentityGraph } from '../integration/identity/graph.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import type { Observation, ProviderContext, Resource, ResourceAdapter, StackState } from '../src/types.ts';
import { fingerprint } from '../src/util.ts';

const target: IdentityTarget = {
  version: 1, id: '1234abcd', directory: '/private/identity/1234abcd',
  context: 'kind-footprint-iac-recording-5678abcd', kubeconfig: '/private/identity/kubeconfig',
  namespace: 'footprint-iac-identity-1234abcd', stateDirectory: '/private/identity/1234abcd/state',
  neoPort: 15001, providerPort: 15002, ldapPort: 15003,
  issuer: 'http://127.0.0.1:15002/realms/neo', providerName: 'footprint-identity-1234abcd-provider',
  directoryName: 'footprint-identity-1234abcd-directory', fixtureDigest: 'a'.repeat(64), providerAddress: '172.18.0.10',
  images: { nodeImage: 'node:test', pythonImage: 'python:test', ldapImage: 'sha256:' + 'b'.repeat(64), providerImage: 'sha256:' + 'c'.repeat(64) },
};

class OwnedTestAdapter implements ResourceAdapter {
  readonly supportsSafeRetry = true;
  readonly scope: string;
  readonly resources = new Map<string, { resource: Resource; stack: string }>();
  readonly removed: string[] = [];
  readonly name: string;
  observations = 0;
  constructor(name: string) { this.name = name; this.scope = 'test-only:' + name; }
  async observe(resource: Resource, context: ProviderContext): Promise<Observation> {
    this.observations++;
    const actual = this.resources.get(resource.id);
    return actual ? { exists: true, owned: actual.stack === context.stack, ready: true,
      fingerprint: fingerprint(actual.resource.spec), physicalId: this.name + ':' + resource.id } : { exists: false };
  }
  async apply(resource: Resource, context: ProviderContext) { this.resources.set(resource.id, { resource: structuredClone(resource), stack: context.stack }); }
  async waitReady() {}
  async remove(resource: Resource, context: ProviderContext) {
    assert.notEqual(resource.spec.kind, 'Namespace', 'namespace deletion must never reach the provider');
    assert.equal(this.resources.get(resource.id)?.stack, context.stack, 'only the stack owner may delete');
    this.removed.push(resource.id); this.resources.delete(resource.id);
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-identity-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStateStore(join(directory, 'state'));
  const kubernetes = new OwnedTestAdapter('kubernetes');
  const identity = new OwnedTestAdapter('local-identity-fixture');
  const engine = new InfraEngine({ adapters: [identity, kubernetes], store });
  const graph = createIdentityGraph(target, { includeNeo: true });
  assert.equal((await engine.apply(graph)).ok, true);
  return { store, kubernetes, identity, engine, graph };
}

test('identity cleanup prunes its owned workloads and fixtures, retains the namespace, and repeats without effects', async t => {
  const { store, kubernetes, identity, engine, graph } = await fixture(t);
  kubernetes.resources.set('other-app', { stack: 'another-stack', resource: {
    id: 'other-app', provider: 'kubernetes', spec: { kind: 'Deployment', metadata: { name: 'other', namespace: 'another-namespace' } },
  } });
  const saved = await store.load(graph.name);
  const cleanup = identityCleanupStack(target, saved);
  const plan = await engine.plan(cleanup, { prune: true });
  assert.equal(plan.operations.find(operation => operation.resource.id === 'neo-namespace')?.action, 'noop');
  assert.deepEqual(plan.operations.filter(operation => operation.action === 'delete').map(operation => operation.resource.id).sort(),
    ['identity-directory', 'identity-provider', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.equal(saved.resources['neo-namespace']?.resource.lifecycle, undefined, 'the source inventory remains unchanged');
  assert.equal((await engine.apply(cleanup, { prune: true })).ok, true);
  assert.deepEqual([...identity.removed, ...kubernetes.removed].sort(), ['identity-directory', 'identity-provider', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.ok(kubernetes.resources.has('neo-namespace'));
  assert.ok(kubernetes.resources.has('other-app'), 'unmanaged foreign workloads remain untouched');
  const retained = await store.load(graph.name);
  assert.deepEqual(Object.keys(retained.resources), ['neo-namespace']);
  assert.equal(retained.resources['neo-namespace']!.resource.lifecycle!.retainOnRemoval, true);
  const repeated = await engine.apply(identityCleanupStack(target, retained), { prune: true });
  assert.equal(repeated.ok, true);
  assert.ok(repeated.plan.operations.every(operation => operation.action === 'noop'));
  assert.equal(identity.removed.length + kubernetes.removed.length, 5);
  const omitted = await engine.plan({ name: graph.name, resources: [] }, { prune: true });
  assert.deepEqual(omitted.retained, [{ resourceId: 'neo-namespace', reason: 'retention-policy' }]);
  assert.equal(omitted.operations.some(operation => operation.action === 'delete'), false);
});

test('identity cleanup cannot turn a foreign saved workload into a deletion', async t => {
  const { store, kubernetes, identity, engine, graph } = await fixture(t);
  kubernetes.resources.get('neo-app')!.stack = 'another-stack';
  await assert.rejects(engine.plan(identityCleanupStack(target, await store.load(graph.name)), { prune: true }), /unowned/);
  assert.equal(identity.removed.length + kubernetes.removed.length, 0);
});

test('malformed or foreign namespace inventory refuses cleanup before provider observation', async t => {
  const { store, kubernetes, identity, graph } = await fixture(t);
  const state = await store.load(graph.name);
  const cases: StackState[] = [structuredClone(state), structuredClone(state), structuredClone(state), structuredClone(state)];
  cases[0]!.stack = 'another-stack';
  (cases[1]!.resources['neo-namespace']!.resource.spec.metadata as Record<string, unknown>).name = 'another-namespace';
  cases[2]!.resources['neo-namespace']!.resource.spec.kind = 'ConfigMap';
  cases[3]!.resources['accidental-namespace'] = { ...structuredClone(state.resources['neo-namespace']!),
    resource: { ...structuredClone(state.resources['neo-namespace']!.resource), id: 'accidental-namespace' } };
  const before = identity.observations + kubernetes.observations;
  for (const invalid of cases) assert.throws(() => identityCleanupStack(target, invalid), /cleanup inventory/);
  assert.equal(identity.observations + kubernetes.observations, before);
  const withoutNamespace = structuredClone(state);
  delete withoutNamespace.resources['neo-namespace'];
  assert.throws(() => identityCleanupStack(target, withoutNamespace), /cleanup inventory/, 'namespaced resources require their declared namespace');
});
