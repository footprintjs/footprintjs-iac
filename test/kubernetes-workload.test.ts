import assert from 'node:assert/strict';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { createHash } from 'node:crypto';
import { compileGraph } from '../src/graph/compile.ts';
import { KubernetesAdapter, type CommandOptions, type CommandRunner } from '../src/providers/kubernetes.ts';
import type { Observation, Resource, ResourceAdapter } from '../src/types.ts';
import {
  compileKubernetesWorkload, GuardedKubernetesAdapter, KubectlKubernetesWorkloadTransport,
  KubernetesExternalReferenceProbe, KubernetesTargetGuard,
} from '../src/kubernetes-workload/index.ts';
import type {
  KubernetesExternalReference, KubernetesReferenceObservation, KubernetesTargetRegistration,
  KubernetesWorkloadInput, KubernetesWorkloadTransport,
} from '../src/kubernetes-workload/index.ts';

const digest = 'a'.repeat(64);
const target: KubernetesTargetRegistration = { apiServer: 'https://cluster.example:6443', caSha256: 'b'.repeat(64), namespace: 'existing', namespaceUid: 'namespace-uid-1' };
const context = { stack: 'production', operationId: 'test-operation' };
function input(): KubernetesWorkloadInput {
  return { stack: 'production', namespace: 'existing', name: 'app', replicas: 2,
    imagePullSecrets: ['registry'], podSecurityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
    containers: [{ name: 'web', image: `registry.example/team/web@sha256:${digest}`, ports: [{ name: 'http', containerPort: 3000 }],
      env: { DB_PASSWORD: { secretKeyRef: { name: 'database', key: 'password' } }, NODE_ENV: { configMapKeyRef: { name: 'settings', key: 'NODE_ENV' } } },
      readinessProbe: { httpGet: { path: '/health', port: 'http' }, timeoutSeconds: 2 },
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } },
      securityContext: { runAsUser: 1000, runAsGroup: 1000 }, volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'settings-volume', mountPath: '/config' }] },
    { name: 'sidecar', image: `registry.example/team/sidecar@sha256:${digest}`, ports: [{ name: 'internal', containerPort: 8000 }],
      env: { ENABLED: { configMapKeyRef: { name: 'settings', key: 'ENABLED' } } } }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'existing-data' } },
      { name: 'settings-volume', configMap: { name: 'settings', items: [{ key: 'app.json', path: 'app.json' }] } }],
    service: { ports: [{ name: 'http', port: 80, targetPort: 'http' }] } };
}

test('pure workload compiler emits one two-container Deployment and ClusterIP Service using existing resources', () => {
  const { graph, references } = compileKubernetesWorkload(input());
  assert.equal(graph.resources.length, 2);
  const deployment = graph.resources.find(resource => resource.spec.kind === 'Deployment')!;
  const pod = (deployment.spec.spec as any).template.spec;
  assert.equal(pod.containers.length, 2);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' });
  assert.deepEqual(pod.containers[0].securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true,
    readOnlyRootFilesystem: true, seccompProfile: { type: 'RuntimeDefault' }, runAsUser: 1000, runAsGroup: 1000 });
  assert.deepEqual(pod.containers[0].env[0], { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'database', key: 'password' } } });
  assert.equal(pod.containers[0].volumeMounts[1].readOnly, true);
  assert.deepEqual((graph.resources[1]!.spec.spec as any).ports, [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }]);
  assert.deepEqual(graph.relations, [{ from: 'app-service', to: 'app-deployment', kind: 'communicatesWith' }]);
  assert.ok(graph.resources.every(resource => !resource.dependsOn));
  assert.deepEqual(references, [
    { kind: 'ConfigMap', namespace: 'existing', name: 'settings', keys: ['ENABLED', 'NODE_ENV', 'app.json'] },
    { kind: 'PersistentVolumeClaim', namespace: 'existing', name: 'existing-data', keys: [] },
    { kind: 'Secret', namespace: 'existing', name: 'database', keys: ['password'] },
    { kind: 'Secret', namespace: 'existing', name: 'registry', keys: ['.dockerconfigjson'] },
  ]);
  assert.ok(Object.isFrozen(graph));
  assert.equal(compileKubernetesWorkload(input()).graph.digest, graph.digest);
});

test('compiler refuses mutable/local images, credentials, unsupported managed infrastructure and unsafe volume options', () => {
  for (const image of ['local:latest', 'registry.example/team/web:latest', `registry.example/team/web@sha256:short`, `user:password@registry.example/web@sha256:${digest}`]) {
    const value = input(); value.containers[0]!.image = image;
    assert.throws(() => compileKubernetesWorkload(value), /immutable registry/);
  }
  assert.throws(() => compileKubernetesWorkload({ ...input(), ingress: {} } as any), /unsupported workload options/);
  assert.throws(() => compileKubernetesWorkload({ ...input(), secret: { password: 'do-not-record' } } as any), /unsupported workload options/);
  assert.throws(() => compileKubernetesWorkload({ ...input(), volumes: [{ name: 'host', hostPath: { path: '/' } }] } as any), /unsupported volume/);
  const rawEnv = input(); rawEnv.containers[0]!.env = { PASSWORD: { value: 'do-not-record' } } as any;
  assert.throws(() => compileKubernetesWorkload(rawEnv), /unsupported environment reference/);
  const wrongPort = input(); wrongPort.service!.ports[0]!.targetPort = 9999;
  assert.throws(() => compileKubernetesWorkload(wrongPort), /declared container port/);
  const root = input(); root.containers[0]!.securityContext = { runAsUser: 0 };
  assert.throws(() => compileKubernetesWorkload(root), /runAsUser/);
});

test('Recreate is explicit by default and rolling update requires a valid declared budget', () => {
  assert.deepEqual((compileKubernetesWorkload(input()).graph.resources[0]!.spec.spec as any).strategy, { type: 'Recreate' });
  const rolling = input(); rolling.deploymentStrategy = { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 } };
  assert.deepEqual((compileKubernetesWorkload(rolling).graph.resources[0]!.spec.spec as any).strategy, rolling.deploymentStrategy);
  rolling.deploymentStrategy = { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: '0%' } };
  assert.throws(() => compileKubernetesWorkload(rolling), /positive surge/);
});

function fixture(options: { observed?: Observation } = {}) {
  const { graph, references } = compileKubernetesWorkload(input());
  const calls: string[] = [];
  let identity = structuredClone(target), observation: Observation = options.observed ?? { exists: false };
  let referenceResult: KubernetesReferenceObservation[] = references.map(reference => ({ ...reference, uid: `uid-${reference.name}`, status: 'present', ready: true }));
  const transport: KubernetesWorkloadTransport = {
    getClusterIdentity: async () => { calls.push('target'); return structuredClone(identity); },
    getReferences: async () => { calls.push('references'); return structuredClone(referenceResult); },
  };
  const delegate: ResourceAdapter = { name: 'kubernetes', scope: 'old-context-alias', supportsSafeRetry: true,
    observe: async () => { calls.push('observe'); return structuredClone(observation); },
    apply: async () => { calls.push('apply'); }, remove: async () => { calls.push('remove'); }, waitReady: async () => { calls.push('ready'); } };
  const guard = new KubernetesTargetGuard({ registration: target, transport });
  const probe = new KubernetesExternalReferenceProbe({ namespace: target.namespace, transport });
  const adapter = new GuardedKubernetesAdapter({ graph, references: [], delegate, guard, probe, allowedRemovals: graph.resources });
  return { adapter, graph, references, calls, guard, probe, transport, delegate,
    identity: (value: KubernetesTargetRegistration) => { identity = structuredClone(value); },
    referenceResult: (value: KubernetesReferenceObservation[]) => { referenceResult = structuredClone(value); },
    observation: (value: Observation) => { observation = value; } };
}

test('guard surrounds every provider entry and repeats immediately before effects after ownership observation', async () => {
  const f = fixture(), resource = f.graph.resources[0]!;
  await f.adapter.observe(resource, context);
  assert.deepEqual(f.calls, ['target', 'references', 'target', 'observe']);
  f.calls.length = 0;
  await f.adapter.apply(resource, context);
  assert.deepEqual(f.calls, ['target', 'references', 'target', 'observe', 'target', 'references', 'target', 'apply']);
  f.calls.length = 0;
  await f.adapter.waitReady(resource, context);
  assert.deepEqual(f.calls, ['target', 'references', 'target', 'ready']);
  f.calls.length = 0; f.observation({ exists: true, owned: true });
  await f.adapter.remove(resource, context);
  assert.deepEqual(f.calls, ['target', 'references', 'target', 'observe', 'target', 'references', 'target', 'remove']);
  assert.equal(f.adapter.scope, f.guard.scope);
  assert.notEqual(f.adapter.scope, f.delegate.scope);
});

test('changed endpoint, trust or namespace UID blocks reads and effects even when the context alias stays unchanged', async () => {
  for (const [field, value, code] of [['apiServer', 'https://other.example', 'target-endpoint-changed'], ['caSha256', 'c'.repeat(64), 'target-trust-changed'], ['namespaceUid', 'recreated-namespace', 'target-namespace-changed']] as const) {
    const f = fixture(); f.identity({ ...target, [field]: value });
    await assert.rejects(f.adapter.apply(f.graph.resources[0]!, context), new RegExp(code));
    assert.deepEqual(f.calls, ['target']);
  }
});

test('missing, forbidden, unknown, missing-key or unbound existing references block all writes', async () => {
  for (const failure of ['missing', 'forbidden', 'unknown', 'missing-key', 'unbound'] as const) {
    const f = fixture();
    const observed: KubernetesReferenceObservation[] = f.references.map(reference => ({ ...reference, uid: `uid-${reference.name}`, status: 'present', ready: true }));
    const index = failure === 'unbound' ? observed.findIndex(item => item.kind === 'PersistentVolumeClaim') : observed.findIndex(item => item.kind === 'Secret');
    if (failure === 'missing-key') observed[index]!.keys = [];
    else if (failure === 'unbound') observed[index]!.ready = false;
    else observed[index]!.status = failure;
    f.referenceResult(observed);
    await assert.rejects(f.adapter.apply(f.graph.resources[0]!, context), /reference-/);
    assert.deepEqual(f.calls, ['target', 'references']);
  }
});

test('unowned existing workload is never adopted, modified or removed', async () => {
  const f = fixture({ observed: { exists: true, owned: false } });
  await assert.rejects(f.adapter.apply(f.graph.resources[0]!, context), /workload-unowned/);
  await assert.rejects(f.adapter.remove(f.graph.resources[0]!, context), /workload-unowned/);
  assert.ok(!f.calls.includes('apply') && !f.calls.includes('remove'));
});

test('retargeting after ownership observation is caught immediately before write', async () => {
  const f = fixture({ observed: { exists: true, owned: true } });
  f.delegate.observe = async () => { f.calls.push('observe'); f.identity({ ...target, namespaceUid: 'other-namespace' }); return { exists: true, owned: true }; };
  await assert.rejects(f.adapter.apply(f.graph.resources[0]!, context), /target-namespace-changed/);
  assert.deepEqual(f.calls, ['target', 'references', 'target', 'observe', 'target']);
});

test('graph and context admission occurs before any I/O; unsupported resource kinds cannot escape via a valid graph envelope', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.apply(f.graph.resources[0]!, { ...context, stack: 'other' }), /context-not-admitted/);
  const changed = structuredClone(f.graph.resources[0]!); (changed.spec.metadata as any).namespace = 'other';
  await assert.rejects(f.adapter.observe(changed, context), /resource-not-admitted/);
  assert.deepEqual(f.calls, []);
  for (const kind of ['Ingress', 'PersistentVolumeClaim', 'Secret']) {
    const graph = compileGraph({ name: 'production', resources: [{ id: 'bad', provider: 'kubernetes', spec: { apiVersion: 'v1', kind, metadata: { name: 'bad', namespace: 'existing' } } }], boundaries: [], memberships: [], relations: [] });
    assert.throws(() => new GuardedKubernetesAdapter({ graph, delegate: f.delegate, guard: f.guard, probe: f.probe }), /only Deployment and ClusterIP/);
  }
  const graph = compileGraph({ name: f.graph.name, resources: structuredClone(f.graph.resources).map(resource => ({ ...resource, spec: { ...resource.spec } })), boundaries: [], memberships: [], relations: [] });
  const withoutRemoval = new GuardedKubernetesAdapter({ graph, delegate: f.delegate, guard: f.guard, probe: f.probe });
  await assert.rejects(withoutRemoval.remove(graph.resources[0]!, context), /resource-not-admitted/);
});

test('public preflight reports contain hashes and reason codes, while unsafe host port payloads or error bodies are refused', async () => {
  const f = fixture();
  const report = await f.adapter.preflight();
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('database') && !serialized.includes('password') && !serialized.includes('cluster.example'));
  f.transport.getReferences = async () => { throw new Error('credential=do-not-record'); };
  await assert.rejects(f.adapter.preflight(), error => error instanceof Error && !error.message.includes('do-not-record') && /reference-observation-unavailable/.test(error.message));
  f.transport.getReferences = async () => f.references.map(reference => ({ ...reference, uid: 'uid', status: 'present', data: { password: 'do-not-record' } } as any));
  await assert.rejects(f.adapter.preflight(), /reference-projection-invalid/);
});

test('guard rejects nested raw graph injection instead of trusting a valid envelope or shallow kind check', () => {
  const mutations: ((resources: Resource[]) => void)[] = [
    resources => { (resources[0]!.spec.metadata as any).annotations = { injected: 'value' }; },
    resources => { ((resources[0]!.spec.spec as any).template.spec.containers[0].securityContext).privileged = true; },
    resources => { ((resources[0]!.spec.spec as any).template.spec.containers[0].securityContext).capabilities.add = ['SYS_ADMIN']; },
    resources => { ((resources[0]!.spec.spec as any).template.spec.containers[0].readinessProbe).exec = { command: ['sh'] }; },
    resources => { ((resources[0]!.spec.spec as any).template.spec.containers[0].volumeMounts[0]).mountPropagation = 'Bidirectional'; },
    resources => { ((resources[0]!.spec.spec as any).template.spec).hostNetwork = true; },
    resources => { ((resources[0]!.spec.spec as any).template.spec.securityContext).sysctls = [{ name: 'x', value: '1' }]; },
    resources => { (resources[0]!.spec.spec as any).strategy.unknown = true; },
    resources => { (resources[0]!.spec.spec as any).selector.matchLabels.injected = 'value'; },
    resources => { (resources[1]!.spec.spec as any).externalIPs = ['1.2.3.4']; },
    resources => { (resources[1]!.spec.spec as any).ports[0].nodePort = 30080; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), resources = structuredClone(f.graph.resources); mutate(resources);
    const graph = compileGraph({ name: f.graph.name, resources, boundaries: [], memberships: [], relations: [] });
    assert.throws(() => new GuardedKubernetesAdapter({ graph, delegate: f.delegate, guard: f.guard, probe: f.probe }));
    assert.deepEqual(f.calls, []);
  }
});

test('every delegate failure is sanitized without cause and provider observations expose only approved facts', async () => {
  for (const method of ['observe', 'apply', 'remove', 'waitReady'] as const) {
    const f = fixture({ observed: { exists: true, owned: true } });
    const failure = Object.assign(new Error('private-sentinel'), { stdout: 'private-sentinel', stderr: 'private-sentinel', cause: new Error('private-sentinel') });
    f.delegate[method] = async () => { throw failure; };
    await assert.rejects(f.adapter[method](f.graph.resources[0]!, context), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider-/);
      assert.ok(!String(error.stack).includes('private-sentinel'));
      assert.ok(!JSON.stringify(error).includes('private-sentinel'));
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  }
  const f = fixture();
  f.delegate.observe = async () => ({ exists: false, physicalId: 'credential=private-sentinel', private: 'private-sentinel' } as any);
  const observation = await f.adapter.observe(f.graph.resources[0]!, context);
  assert.ok(!JSON.stringify(observation).includes('private-sentinel'));
  assert.match(observation.physicalId!, /^kubernetes-pinned:\/\/[a-f0-9]{64}$/);
  f.delegate.observe = async () => ({ exists: false, fingerprint: { token: 'private-sentinel', toString: () => 'a'.repeat(64) } } as any);
  await assert.rejects(f.adapter.observe(f.graph.resources[0]!, context), /provider-observation-invalid/);
});

test('guarded real KubernetesAdapter refuses unowned target before a create/apply command', async () => {
  const f = fixture(), calls: string[][] = [], resource = f.graph.resources[0]!;
  const delegate = new KubernetesAdapter({ context: 'company', kubeconfig: '/host/isolated', namespace: 'existing', runner: async (_command, args) => {
    calls.push([...args]); return { stdout: JSON.stringify(resource.spec) };
  } });
  const adapter = new GuardedKubernetesAdapter({ graph: f.graph, delegate, guard: f.guard, probe: f.probe });
  await assert.rejects(adapter.apply(resource, context), /workload-unowned/);
  assert.equal(calls.length, 1); assert.ok(calls[0]!.includes('get'));
});

test('kubectl transport requests projected key names, distinguishes missing/forbidden/unknown and never returns Secret values', async () => {
  const calls: { args: readonly string[]; options: CommandOptions }[] = [];
  const results: (string | Error)[] = [JSON.stringify({ kind: 'Secret', namespace: 'existing', name: 'database', uid: 'secret-uid', keys: ['password', null], phase: '' }), '', new Error('Error from server (Forbidden): hidden-body'), new Error('transport hidden-body')];
  const runner: CommandRunner = async (_command, args, options) => {
    calls.push({ args, options }); const result = results.shift(); if (result instanceof Error) throw result; return { stdout: result! };
  };
  const transport = new KubectlKubernetesWorkloadTransport({ context: 'company', kubeconfig: '/host/isolated', runner });
  const ref: KubernetesExternalReference = { kind: 'Secret', namespace: 'existing', name: 'database', keys: ['password'] };
  assert.deepEqual(await transport.getReferences([ref]), [{ kind: 'Secret', namespace: 'existing', name: 'database', uid: 'secret-uid', keys: ['password'], status: 'present' }]);
  assert.equal((await transport.getReferences([ref]))[0]!.status, 'missing');
  assert.equal((await transport.getReferences([ref]))[0]!.status, 'forbidden');
  assert.equal((await transport.getReferences([ref]))[0]!.status, 'unknown');
  for (const call of calls) {
    assert.ok(call.args.includes('get') && call.args.includes('--ignore-not-found=true'));
    assert.ok(call.args.some(arg => arg.startsWith('go-template=') && arg.includes('{{printf "%q," $key}}')));
    assert.ok(!call.args.includes('json') && !call.args.includes('--output=json') && call.options.input === undefined);
    assert.ok(!call.args.some(arg => arg.includes('{{printf "%q," $value}}')));
  }
});

test('kubectl target identity pins projected endpoint, exact CA bytes and actual namespace UID without reading auth fields', async () => {
  const ca = Buffer.from(rootCertificates[0]!); const selected = `https://cluster.example:6443\n${ca.toString('base64')}\nfalse\n`;
  const calls: readonly string[][] = [] as string[][];
  let count = 0;
  const transport = new KubectlKubernetesWorkloadTransport({ context: 'company', kubeconfig: '/host/isolated', runner: async (_command, args) => {
    (calls as string[][]).push([...args]); return { stdout: ++count === 2 ? '{"name":"existing","uid":"actual-uid"}' : selected };
  } });
  assert.deepEqual(await transport.getClusterIdentity('existing'), { apiServer: 'https://cluster.example:6443', caSha256: createHash('sha256').update(ca).digest('hex'), namespace: 'existing', namespaceUid: 'actual-uid' });
  assert.equal(calls.length, 3);
  assert.ok(calls.filter(args => args.includes('config')).every(args => args.some(arg => arg.startsWith('go-template=') && !arg.includes('.users') && !arg.includes('client-key') && !arg.includes('token'))));
  const insecure = new KubectlKubernetesWorkloadTransport({ context: 'company', kubeconfig: '/host/isolated', runner: async () => ({ stdout: selected.replace('false', 'true') }) });
  await assert.rejects(insecure.getClusterIdentity('existing'), /could not be verified/);
});
