import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import { createNeoStack, NEO_NAMESPACE } from '../integration/neo/stack.ts';
import { KubernetesConnectionAdapter, KubernetesConnectionError } from '../src/connections/kubernetes.ts';
import { HTTP_CONNECTION_SCRIPT } from '../src/connections/kubernetes/http-script.ts';
import type { ConnectionCheckRequest } from '../src/connections/types.ts';
import type { CommandOptions, CommandRunner } from '../src/providers/kubernetes.ts';
import { fingerprint } from '../src/util.ts';

const namespace = NEO_NAMESPACE;
const stack = createNeoStack();
const request: ConnectionCheckRequest = { connectionId: 'communication:0', stack: stack.name,
  from: stack.resources.find(r => r.id === 'neo-service')!, to: stack.resources.find(r => r.id === 'neo-app')!,
  relation: { from: 'neo-service', to: 'neo-app', kind: 'communicatesWith' } };
const options = { context: 'kind-connection-test', kubeconfig: '/private/fixture/kubeconfig', namespace };

function fixture() {
  const own = (resource: typeof request.from, uid: string) => {
    const live: any = structuredClone(resource.spec);
    live.metadata = { ...live.metadata, uid, generation: 1, annotations: {
      'footprint-iac.dev/owner': fingerprint({ stack: request.stack, id: resource.id }),
      'footprint-iac.dev/stack': request.stack, 'footprint-iac.dev/resource': resource.id,
    } };
    return live;
  };
  const service = own(request.from, 'service-uid');
  service.spec.clusterIP = '10.96.0.20'; service.spec.clusterIPs = ['10.96.0.20'];
  const deployment = own(request.to, 'deployment-uid');
  deployment.status = { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 };
  const replicaSets: any[] = [{ metadata: { uid: 'replicaset-uid', namespace,
    ownerReferences: [{ kind: 'Deployment', uid: 'deployment-uid', controller: true }] } }];
  const pods: any[] = [{ metadata: { name: 'neo-pod', uid: 'pod-uid', namespace, labels: deployment.spec.template.metadata.labels,
    ownerReferences: [{ kind: 'ReplicaSet', uid: 'replicaset-uid', controller: true }] },
  spec: deployment.spec.template.spec, status: { phase: 'Running', podIP: '10.244.0.7', podIPs: [{ ip: '10.244.0.7' }],
    conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'node', ready: true }] } }];
  const endpointSlices: any[] = [{ metadata: { name: 'neo-endpoints', namespace, labels: { 'kubernetes.io/service-name': 'neo' },
    ownerReferences: [{ kind: 'Service', uid: 'service-uid', controller: true }] },
  ports: [{ name: 'http', protocol: 'TCP', port: 5230 }], endpoints: [{ conditions: { ready: true },
    addresses: ['10.244.0.7'], targetRef: { kind: 'Pod', uid: 'pod-uid', name: 'neo-pod', namespace } }] }];
  let probe: any = { ok: true, stage: 'complete', addresses: ['10.96.0.20'], httpStatus: 200,
    responseStatus: 'ok', latencyMs: 12, observedAt: Date.now() };
  const calls: { command: string; args: readonly string[]; options: CommandOptions }[] = [];
  let afterProbe: (() => void) | undefined;
  const runner: CommandRunner = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    if (args.includes('exec')) { afterProbe?.(); if (probe instanceof Error) throw probe; return { stdout: JSON.stringify(probe) }; }
    const kind = args[args.indexOf('get') + 1];
    const value = kind === 'service' ? service : kind === 'deployment' ? deployment
      : kind === 'replicasets' ? { items: replicaSets } : kind === 'pods' ? { items: pods }
        : kind === 'endpointslices.discovery.k8s.io' ? { items: endpointSlices } : undefined;
    assert.ok(value, `Unexpected kubectl command ${args.join(' ')}`);
    return { stdout: JSON.stringify(value) };
  };
  return { service, deployment, replicaSets, pods, endpointSlices, calls, runner,
    setProbe(value: any) { probe = value; }, afterProbe(callback: () => void) { afterProbe = callback; } };
}

test('connection observation traverses Service DNS from an owned ready pod and verifies backend identities again', async () => {
  const f = fixture();
  const result = await new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request);
  assert.equal(result.method, 'kubernetes-service-http');
  assert.equal(result.target, `http://neo.${namespace}.svc.cluster.local:5230/health`);
  assert.equal(result.latencyMs, 12);
  assert.deepEqual(result.details.before, result.details.after);
  assert.equal((result.details.before as any).serviceUID, 'service-uid');
  assert.equal((result.details.before as any).deploymentUID, 'deployment-uid');
  assert.deepEqual((result.details.before as any).sourcePod, { name: 'neo-pod', uid: 'pod-uid', ip: '10.244.0.7' });
  assert.equal(f.calls.length, 11);
  for (const call of f.calls) {
    assert.equal(call.command, 'kubectl');
    assert.deepEqual(call.args.slice(0, 6), ['--kubeconfig', options.kubeconfig, '--context', options.context, '--namespace', namespace]);
    assert.ok(call.options.timeoutMs <= 5000);
    assert.ok(!call.args.includes('port-forward') && !call.args.includes('sh'));
  }
  const command = f.calls[5]!.args;
  assert.deepEqual(command.slice(command.indexOf('exec'), -2), ['exec', 'neo-pod', '--container', 'node', '--', 'node', '-e']);
  assert.equal(command.at(-2), HTTP_CONNECTION_SCRIPT);
  assert.deepEqual(JSON.parse(command.at(-1)!), { url: result.target, clusterIPs: ['10.96.0.20'], timeoutMs: 3000 });
});

test('connection admission refuses unowned resources, unrelated backends and unready endpoints before executing in a pod', async () => {
  for (const fault of [
    (f: ReturnType<typeof fixture>) => { f.service.metadata.annotations['footprint-iac.dev/owner'] = 'foreign'; },
    (f: ReturnType<typeof fixture>) => { f.endpointSlices[0].endpoints[0].targetRef.uid = 'foreign-pod'; },
    (f: ReturnType<typeof fixture>) => { f.endpointSlices[0].endpoints[0].conditions.ready = false; },
    (f: ReturnType<typeof fixture>) => { f.replicaSets[0].metadata.ownerReferences[0].uid = 'other-deployment'; },
    (f: ReturnType<typeof fixture>) => { f.endpointSlices[0].metadata.ownerReferences[0].uid = 'other-service'; },
  ]) {
    const f = fixture(); fault(f);
    await assert.rejects(new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request), KubernetesConnectionError);
    assert.equal(f.calls.filter(call => call.args.includes('exec')).length, 0);
  }
});

test('missing Deployment readiness or source identities remain unverified and never execute a probe', async () => {
  for (const fault of [
    (f: ReturnType<typeof fixture>) => { delete f.deployment.status.availableReplicas; },
    (f: ReturnType<typeof fixture>) => { delete f.deployment.status.observedGeneration; },
    (f: ReturnType<typeof fixture>) => { delete f.deployment.metadata.generation; },
    (f: ReturnType<typeof fixture>) => { f.deployment.spec.replicas = '1'; },
    (f: ReturnType<typeof fixture>) => { delete f.service.metadata.uid; },
    (f: ReturnType<typeof fixture>) => { delete f.replicaSets[0].metadata.uid; },
    (f: ReturnType<typeof fixture>) => { delete f.pods[0].metadata.uid; delete f.endpointSlices[0].endpoints[0].targetRef.uid; },
    (f: ReturnType<typeof fixture>) => { delete f.pods[0].status.podIP; },
  ]) {
    const f = fixture(); fault(f);
    await assert.rejects(new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request), KubernetesConnectionError);
    assert.equal(f.calls.filter(call => call.args.includes('exec')).length, 0);
  }
});

test('a real HTTP failure retains actual targetPort routing and measured failure details', async () => {
  const f = fixture();
  f.service.spec.ports[0].targetPort = 5999; f.endpointSlices[0].ports[0].port = 5999;
  f.setProbe({ ok: false, stage: 'http', addresses: ['10.96.0.20'], httpStatus: null,
    latencyMs: 3000, observedAt: Date.now(), error: 'Connection probe timed out' });
  await assert.rejects(new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request), error => {
    assert.ok(error instanceof KubernetesConnectionError);
    assert.match(error.message, /timed out/);
    assert.equal((error.details!.before as any).targetPort, 5999);
    assert.deepEqual((error.details!.after as any).endpointPorts, [5999]);
    assert.equal(error.observation!.target, `http://neo.${namespace}.svc.cluster.local:5230/health`);
    assert.equal(error.observation!.latencyMs, 3000);
    return true;
  });
  assert.equal(f.calls.filter(call => call.args.includes('exec')).length, 1);
});

test('HTTP status, DNS mismatch, invalid health response and exec failure cannot become connected', async () => {
  for (const failure of [
    { ok: false, stage: 'http', addresses: ['10.96.0.20'], httpStatus: 503, error: 'HTTP health request returned 503' },
    { ok: true, stage: 'complete', addresses: ['192.0.2.10'], httpStatus: 200, responseStatus: 'ok' },
    { ok: true, stage: 'complete', addresses: ['10.96.0.20'], httpStatus: 200, responseStatus: 'error' },
    new Error('kubectl connection timed out'),
  ]) {
    const f = fixture(); f.setProbe(failure instanceof Error ? failure : { ...failure, observedAt: Date.now(), latencyMs: 10 });
    await assert.rejects(new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request), error => {
      assert.ok(error instanceof KubernetesConnectionError);
      assert.ok(error.observation?.details.probe);
      return true;
    });
  }
});

test('a successful response is rejected if routing changes before the final observation', async () => {
  const f = fixture();
  f.afterProbe(() => { f.service.spec.ports[0].targetPort = 7777; f.endpointSlices[0].ports[0].port = 7777; });
  await assert.rejects(new KubernetesConnectionAdapter({ ...options, runner: f.runner }).check(request), error => {
    assert.ok(error instanceof KubernetesConnectionError); assert.match(error.message, /changed during/);
    assert.equal((error.observation!.details.probe as any).ok, true);
    assert.notDeepEqual(error.details!.before, error.details!.after);
    return true;
  });
});

test('connection configuration and mutable caller options cannot retarget an observation', async () => {
  const f = fixture(); const selected = { ...options, runner: f.runner };
  const adapter = new KubernetesConnectionAdapter(selected);
  selected.context = 'production'; selected.kubeconfig = '/foreign/config';
  await adapter.check(request);
  assert.ok(f.calls.every(call => call.args.includes(options.context) && call.args.includes(options.kubeconfig)));
  for (const change of [{ context: '' }, { kubeconfig: '-unsafe' }, { namespace: 'bad name' },
    { path: '//external.example' }, { path: '/health?token=secret' }, { timeoutMs: 0 }, { timeoutMs: 30001 }]) {
    assert.throws(() => new KubernetesConnectionAdapter({ ...options, ...change }), /explicit Kubernetes selectors/);
  }
});

test('fixed probe program makes a real DNS/HTTP request and rejects a real unsuccessful response', async t => {
  let healthy = true;
  let invalidBody = false;
  const server = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(invalidBody ? 'private-response-body: NOT_JSON' : JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  t.after(() => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
  const port = (server.address() as { port: number }).port;
  const run = async () => {
    const result = await promisify(execFile)(process.execPath, ['-e', HTTP_CONNECTION_SCRIPT,
      JSON.stringify({ url: `http://localhost:${port}/health`, clusterIPs: ['127.0.0.1', '::1'], timeoutMs: 1000 })], { timeout: 3000 });
    return JSON.parse(result.stdout);
  };
  const success = await run();
  assert.equal(success.ok, true); assert.equal(success.httpStatus, 200); assert.equal(success.stage, 'complete');
  assert.ok(success.addresses.includes('127.0.0.1')); assert.ok(success.latencyMs >= 0);
  healthy = false;
  const failure = await run();
  assert.equal(failure.ok, false); assert.equal(failure.httpStatus, 503); assert.equal(failure.stage, 'http');
  healthy = true; invalidBody = true;
  const malformed = await run();
  assert.equal(malformed.ok, false); assert.equal(malformed.stage, 'response');
  assert.equal(malformed.error, 'Health response was not valid JSON');
  assert.ok(!JSON.stringify(malformed).includes('private-response-body'));
});

test('real refused connections retain bounded nested transport codes, addresses and ports', async () => {
  const reservation = createServer();
  await new Promise<void>((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const response = await promisify(execFile)(process.execPath, ['-e', HTTP_CONNECTION_SCRIPT,
    JSON.stringify({ url: `http://localhost:${port}/health`, clusterIPs: ['127.0.0.1', '::1'], timeoutMs: 1000 })], { timeout: 3000 });
  const result = JSON.parse(response.stdout);
  assert.equal(result.ok, false); assert.equal(result.stage, 'http'); assert.equal(result.error, 'fetch failed');
  const failures: any[] = [];
  function walk(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.code === 'ECONNREFUSED') failures.push(value);
    walk(value.cause); for (const nested of value.errors ?? []) walk(nested);
  }
  walk(result.transportError);
  assert.ok(failures.length > 0, 'actual fetch cause must retain its ECONNREFUSED code');
  const addressed = failures.filter(error => error.address !== undefined || error.port !== undefined);
  assert.ok(addressed.length > 0, 'the concrete socket failure must retain its address and port');
  assert.ok(addressed.every(error => ['127.0.0.1', '::1'].includes(error.address) && error.port === port));
  assert.ok(JSON.stringify(result.transportError).length < 5000);
});
