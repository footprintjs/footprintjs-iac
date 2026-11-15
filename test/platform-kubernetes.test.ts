import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PinnedKubernetesClusterConnection, type KubernetesReadResponse, type PinnedKubernetesConnectionOptions } from '../src/platform-kubernetes/index.ts';

const ca = 'controlled-test-ca';
const context = { executionId: 'platform-run-a', operationId: 'platform-check-a', completedActionIds: [] };
function fixture(overrides: Partial<PinnedKubernetesConnectionOptions> = {}) {
  const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'platform-a', uid: 'namespace-uid-a' } };
  const nodes = { apiVersion: 'v1', kind: 'NodeList', items: [{ metadata: { name: 'node-a', uid: 'node-uid-a' },
    status: { nodeInfo: { kubeletVersion: 'v1.35.0' }, conditions: [{ type: 'Ready', status: 'True' }] } }] };
  const pods = { apiVersion: 'v1', kind: 'PodList', items: [{ metadata: { namespace: 'kube-system', name: 'dns-a', uid: 'dns-uid-a' },
    spec: { containers: [{ name: 'dns' }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'dns', ready: true }] } }] };
  const cni = { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { namespace: 'kube-system', name: 'network-a', uid: 'cni-uid-a', generation: 3 },
    status: { observedGeneration: 3, desiredNumberScheduled: 1, currentNumberScheduled: 1, updatedNumberScheduled: 1, numberReady: 1, numberAvailable: 1, numberMisscheduled: 0 } };
  const responses = new Map<string, KubernetesReadResponse>([
    ['/api/v1/namespaces/platform-a', { status: 200, body: namespace }], ['/version', { status: 200, body: { gitVersion: 'v1.35.0' } }],
    ['/readyz', { status: 200, body: 'ok\n' }], ['/api/v1/nodes', { status: 200, body: nodes }],
    ['/api/v1/namespaces/kube-system/pods', { status: 200, body: pods }],
    ['/apis/apps/v1/namespaces/kube-system/daemonsets/network-a', { status: 200, body: cni }],
  ]);
  const paths: string[] = [];
  const options: PinnedKubernetesConnectionOptions = { resourceId: 'cluster-a', scope: 'existing-platform-a', ca,
    registration: { apiServer: 'https://cluster.example.test:6443', caSha256: createHash('sha256').update(ca).digest('hex'), namespace: 'platform-a', namespaceUid: 'namespace-uid-a' },
    expectedVersion: '1.35.0', expectedNodeNames: ['node-a'], expectedProfileId: 'kubernetes-access-a', cni: { namespace: 'kube-system', kind: 'DaemonSet', name: 'network-a' },
    runner: async (...args) => { assert.equal(args.length, 1, 'the port cannot carry methods or mutation bodies'); paths.push(args[0]); return responses.get(args[0]) ?? { status: 404, body: null }; }, ...overrides };
  return { connection: new PinnedKubernetesClusterConnection(options), options, namespace, nodes, pods, cni, paths, responses };
}

test('pinned existing-cluster inspection and four measured readiness checks issue only fixed GET paths', async () => {
  const f = fixture(), observed = await f.connection.inspect(context);
  assert.equal(observed.status, 'present'); assert.equal(observed.platformVersion, '1.35.0');
  const verified = await f.connection.verify(observed.resource!, 'kubernetes-access-a', context);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.checks.map(check => check.id), ['api', 'nodes-ready', 'system-pods-ready', 'cni-ready']);
  assert.ok(verified.checks.every(check => check.passed));
  assert.ok(f.paths.every(path => !/[?#]/.test(path)));
  assert.deepEqual([...new Set(f.paths)].sort(), [...f.responses.keys()].sort());
});

test('declared Kubernetes node names support DNS subdomains without accepting invalid labels', async () => {
  const hostname = 'node-a.internal.example';
  const f = fixture({ expectedNodeNames: [hostname] });
  f.nodes.items[0]!.metadata.name = hostname;
  const resource = (await f.connection.inspect(context)).resource!;
  assert.equal((await f.connection.verify(resource, 'kubernetes-access-a', context)).ok, true);
  for (const value of ['node..example', '-node.example', 'Node.example', 'a'.repeat(64) + '.example', 'node.example/other']) {
    assert.throws(() => fixture({ expectedNodeNames: [value] }), /Invalid pinned Kubernetes/);
  }
});

test('TLS endpoint, exact CA, credentials pairing and finite static path selectors are admitted before any I/O', () => {
  const f = fixture();
  assert.throws(() => fixture({ ca: 'different-ca' }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ registration: { ...f.options.registration, apiServer: 'http://insecure.example.test' } }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ registration: { ...f.options.registration, apiServer: 'https://token:private@cluster.example.test' } }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ cni: { namespace: 'kube-system', kind: 'DaemonSet', name: 'network-a?secret=token' } }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ cert: 'client-cert-without-key' }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ expectedNodeNames: [] }), /Invalid pinned Kubernetes/);
  assert.throws(() => fixture({ timeoutMs: 0 }), /Invalid pinned Kubernetes/);
});

test('namespace substitution before or during observation stays unknown and never becomes absent', async () => {
  const first = fixture(); first.namespace.metadata.uid = 'foreign-namespace';
  assert.deepEqual(await first.connection.inspect(context), { status: 'unknown' });
  assert.equal(first.paths.length, 1);
  const second = fixture(), original = second.options.runner!; let reads = 0;
  const changed = new PinnedKubernetesClusterConnection({ ...second.options, runner: async path => {
    if (path === '/api/v1/namespaces/platform-a' && ++reads === 2) return { status: 200, body: { ...second.namespace, metadata: { name: 'platform-a', uid: 'changed-during-observation' } } };
    return original(path);
  } });
  assert.deepEqual(await changed.inspect(context), { status: 'unknown' });
  const failed = fixture({ runner: async () => { throw Error('private-provider-token-body'); } });
  assert.deepEqual(await failed.connection.inspect(context), { status: 'unknown' });
});

test('API ready alone cannot hide unready nodes, incomplete system pods or an outdated CNI rollout', async () => {
  for (const failure of ['nodes', 'pods', 'cni'] as const) {
    const f = fixture(), resource = (await f.connection.inspect(context)).resource!;
    if (failure === 'nodes') f.nodes.items[0]!.status.conditions[0]!.status = 'False';
    if (failure === 'pods') f.pods.items[0]!.status.containerStatuses[0]!.ready = false;
    if (failure === 'cni') f.cni.status.observedGeneration = 2;
    const result = await f.connection.verify(resource, 'kubernetes-access-a', context);
    assert.equal(result.ok, false); assert.equal(result.checks.find(check => check.id === 'api')?.passed, true);
    assert.equal(result.checks.find(check => check.id === ({ nodes: 'nodes-ready', pods: 'system-pods-ready', cni: 'cni-ready' }[failure]))?.passed, false);
  }
});

test('unknown, malformed, empty or unexpected readiness observations cannot yield success or leak bodies', async () => {
  for (const [path, body] of [['/version', { private: 'never-record-this-token' }], ['/readyz', { status: 'ok' }],
    ['/api/v1/nodes', { apiVersion: 'v1', kind: 'NodeList', items: [] }], ['/api/v1/namespaces/kube-system/pods', { apiVersion: 'v1', kind: 'PodList', items: [] }]] as const) {
    const f = fixture(), resource = (await f.connection.inspect(context)).resource!;
    f.responses.set(path, { status: 200, body });
    const result = await f.connection.verify(resource, 'kubernetes-access-a', context);
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('never-record-this-token'), false);
  }
  const version = fixture(), resource = (await version.connection.inspect(context)).resource!;
  version.responses.set('/version', { status: 200, body: { gitVersion: 'v1.36.0' } });
  assert.equal((await version.connection.inspect(context)).platformVersion, '1.36.0', 'actual version is observed for the existing-cluster compatibility policy');
  assert.equal((await version.connection.verify(resource, 'kubernetes-access-a', context)).ok, false);
});

test('profile verification is bound to the configured immutable credential profile or its first successful publication', async () => {
  const f = fixture({ expectedProfileId: undefined, publishAccess: async () => ({ profileId: 'published-kubernetes-access' }) });
  const resource = (await f.connection.inspect(context)).resource!;
  assert.equal((await f.connection.verify(resource, 'unbound-profile', context)).ok, false);
  assert.deepEqual(await f.connection.publishAccess(resource, context), { profileId: 'published-kubernetes-access' });
  assert.equal((await f.connection.verify(resource, 'published-kubernetes-access', context)).ok, true);
  assert.equal((await f.connection.verify(resource, 'different-profile', context)).ok, false);
  const refused = fixture({ publishAccess: async () => ({ profileId: 'different-profile' }) });
  await assert.rejects(refused.connection.publishAccess((await refused.connection.inspect(context)).resource!, context), /Kubernetes access publication unavailable/);
});

test('the constructor snapshots registrations and readiness requires the complete declared node set', async () => {
  const f = fixture(), resource = (await f.connection.inspect(context)).resource!;
  f.options.registration.namespaceUid = 'changed-input'; f.options.expectedNodeNames = ['changed-node']; f.options.cni.name = 'changed-cni';
  assert.equal((await f.connection.verify(resource, 'kubernetes-access-a', context)).ok, true);
  f.nodes.items.push({ ...structuredClone(f.nodes.items[0]!), metadata: { name: 'unexpected-node', uid: 'extra-node' } });
  assert.equal((await f.connection.verify(resource, 'kubernetes-access-a', context)).ok, false);
});

test('a fixed Deployment CNI selector requires current-generation available updated replicas', async () => {
  const f = fixture({ cni: { namespace: 'kube-system', kind: 'Deployment', name: 'network-controller' } });
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: 'kube-system', name: 'network-controller', uid: 'controller-uid', generation: 2 }, spec: { replicas: 1 },
    status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, conditions: [{ type: 'Available', status: 'True' }] } };
  f.responses.set('/apis/apps/v1/namespaces/kube-system/deployments/network-controller', { status: 200, body: deployment });
  const resource = (await f.connection.inspect(context)).resource!;
  assert.equal((await f.connection.verify(resource, 'kubernetes-access-a', context)).ok, true);
  deployment.status.availableReplicas = 0;
  assert.equal((await f.connection.verify(resource, 'kubernetes-access-a', context)).ok, false);
});

test('credential resolution is bounded and aborted before any HTTPS request can start', async () => {
  let signal: AbortSignal | undefined;
  const stalled = fixture({ runner: undefined, timeoutMs: 100, token: async input => {
    signal = input; return new Promise<string>(() => undefined);
  } });
  const started = performance.now();
  assert.deepEqual(await stalled.connection.inspect(context), { status: 'unknown' });
  assert.ok(performance.now() - started < 2000); assert.equal(signal?.aborted, true);
  const failed = fixture({ runner: undefined, token: async () => { throw Error('private-credential-broker-body'); } });
  const observed = await failed.connection.inspect(context);
  assert.deepEqual(observed, { status: 'unknown' });
  assert.equal(JSON.stringify(observed).includes('private-credential-broker-body'), false);
});
