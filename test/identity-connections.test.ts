import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { neoIdentityConnectionAdapter } from '../integration/identity/index.ts';
import { JWKS_CONNECTION_SCRIPT } from '../integration/identity/connections/jwks-script.ts';
import { createIdentityGraph } from '../integration/identity/graph.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { checkConnections, createConnectionRecorder } from '../src/connections/index.ts';
import { ConnectionCheckError, type ConnectionCheckRequest } from '../src/connections/types.ts';
import type { CommandOptions, CommandRunner } from '../src/providers/kubernetes.ts';
import type { Resource, ResourceAdapter } from '../src/types.ts';
import { fingerprint } from '../src/util.ts';

const privateCanary = 'secret-private-canary';
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t: { after(callback: () => Promise<unknown>): void }) {
  const base = await mkdtemp(join(tmpdir(), 'identity-connections-')), root = join(base, '.artifacts/identity'), id = 'a1b2c3d4';
  t.after(() => rm(base, { recursive: true, force: true }));
  const target: IdentityTarget = { version: 1, id, directory: resolve(root, id), stateDirectory: resolve(root, id, 'state'),
    context: 'kind-footprint-iac-recording-b1b2c3d4', namespace: `footprint-iac-identity-${id}`,
    kubeconfig: resolve(root, '../..', '.artifacts/neo/fresh/b1b2c3d4/kubeconfig'), neoPort: 15230, providerPort: 15231, ldapPort: 15232,
    issuer: 'http://127.0.0.1:15231/realms/neo', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
    fixtureDigest: 'a'.repeat(64), providerAddress: '172.18.0.5', images: { nodeImage: 'sha256:' + '1'.repeat(64), pythonImage: 'sha256:' + '2'.repeat(64),
      ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  const realm = { realm: 'neo', components: { 'org.keycloak.storage.UserStorageProvider': [{ providerId: 'ldap', config: {
    enabled: ['true'], importEnabled: ['false'], cachePolicy: ['NO_CACHE'], connectionUrl: [`ldaps://${target.directoryName}:1636`],
    connectionPooling: ['false'], useTruststoreSpi: ['always'],
  } }] } };
  await mkdir(join(target.directory, 'provider'), { recursive: true });
  const writeRealm = () => writeFile(join(target.directory, 'provider/neo-realm.json'), JSON.stringify(realm)); await writeRealm();
  const graph = createIdentityGraph(target, { includeNeo: true });
  const request = (index: number): ConnectionCheckRequest => {
    const relationIndex = graph.relations.findIndex(relation => relation.kind === 'communicatesWith' && relation.from === ['identity-provider', 'neo-app', 'neo-service'][index]);
    const relation = graph.relations[relationIndex]!;
    return { connectionId: `communication:${relationIndex}`, stack: graph.name, relation,
      from: graph.resources.find(resource => resource.id === relation.from)!, to: graph.resources.find(resource => resource.id === relation.to)! };
  };
  const own = (resource: Resource, uid: string) => {
    const live: any = structuredClone(resource.spec);
    live.metadata = { ...live.metadata, uid, generation: 1, annotations: { 'footprint-iac.dev/owner': fingerprint({ stack: graph.name, id: resource.id }),
      'footprint-iac.dev/stack': graph.name, 'footprint-iac.dev/resource': resource.id } }; return live;
  };
  const deployment = own(request(1).from, 'deployment-uid');
  deployment.status = { observedGeneration: 1, replicas: 1, availableReplicas: 1, updatedReplicas: 1 };
  const service = own(request(2).from, 'service-uid'); service.spec.clusterIP = '10.96.0.20'; service.spec.clusterIPs = ['10.96.0.20'];
  const replicaSets: any[] = [{ metadata: { uid: 'rs-uid', namespace: target.namespace, ownerReferences: [{ kind: 'Deployment', uid: 'deployment-uid', controller: true }] } }];
  const pods: any[] = [{ metadata: { name: 'neo-pod', uid: 'pod-uid', namespace: target.namespace, labels: deployment.spec.template.metadata.labels,
    ownerReferences: [{ kind: 'ReplicaSet', uid: 'rs-uid', controller: true }] }, spec: structuredClone(deployment.spec.template.spec),
  status: { phase: 'Running', podIP: '10.244.0.7', podIPs: [{ ip: '10.244.0.7' }], conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'node', ready: true }] } }];
  const endpointSlices: any[] = [{ metadata: { name: 'neo-endpoints', namespace: target.namespace, labels: { 'kubernetes.io/service-name': 'neo' },
    ownerReferences: [{ kind: 'Service', uid: 'service-uid', controller: true }] }, ports: [{ port: 5230, protocol: 'TCP' }],
  endpoints: [{ addresses: ['10.244.0.7'], conditions: { ready: true }, targetRef: { kind: 'Pod', uid: 'pod-uid', name: 'neo-pod', namespace: target.namespace } }] }];
  const state = { directory: true, provider: true, jwks: true, service: true, owned: true, sealed: true, afterExec: () => {} };
  const calls: { command: string; args: readonly string[]; options: CommandOptions }[] = [], logins: string[] = [];
  const ids = { 'identity-provider': 'b'.repeat(64), 'identity-directory': 'c'.repeat(64) };
  const fixtureAdapter: Pick<ResourceAdapter, 'observe'> = { async observe(resource) { return { exists: true, owned: state.owned,
    physicalId: ids[resource.id as keyof typeof ids], fingerprint: fingerprint(resource.spec), ready: true }; } };
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'docker') {
      const provider = args.at(-1) === ids['identity-provider'];
      return { stdout: JSON.stringify({ id: args.at(-1), name: '/' + (provider ? target.providerName : target.directoryName),
        running: provider ? state.provider : state.directory, address: provider ? target.providerAddress : '172.18.0.6' }) };
    }
    if (args.includes('exec')) {
      const jwks = args.at(-2) === JWKS_CONNECTION_SCRIPT; state.afterExec();
      const ok = jwks ? state.jwks : state.service;
      return { stdout: JSON.stringify(jwks ? { ok, code: ok ? 'verified' : 'jwks-transport-failed', httpStatus: ok ? 200 : null, signingKeys: ok ? 1 : 0,
        observedAt: Date.now(), latencyMs: 4, error: privateCanary } : { ok, stage: ok ? 'complete' : 'http', httpStatus: ok ? 200 : null,
        addresses: ['10.96.0.20'], responseStatus: 'ok', observedAt: Date.now(), latencyMs: 5, error: privateCanary,
        transportError: { message: privateCanary, cause: { code: 'ECONNREFUSED', address: '10.96.0.20', port: 5230 } } }) };
    }
    const kind = String(args[args.indexOf('get') + 1]).toLowerCase();
    const value = kind === 'deployment' ? deployment : kind === 'service' ? service : kind === 'replicasets' ? { items: replicaSets }
      : kind === 'pods' ? { items: pods } : kind === 'endpointslices.discovery.k8s.io' ? { items: endpointSlices } : undefined;
    assert.ok(value, 'Unexpected read'); return { stdout: JSON.stringify(value) };
  };
  const adapter = await neoIdentityConnectionAdapter(target, { fixtureRoot: root, runner, fixtureAdapter,
    loadTarget: async () => ({ ...target, fixtureDigest: state.sealed ? target.fixtureDigest : 'f'.repeat(64) }),
    identityOptions: { directory: { id: 'test-unused-direct-bind', async authenticate() { throw Error('Should use broker LDAPS path'); } },
      readCredentials: async () => ({ alice: privateCanary, bob: privateCanary, directoryAdmin: privateCanary }),
      fetch: async (url, init) => { assert.equal(url, target.issuer + '/protocol/openid-connect/token');
        assert.equal(init?.redirect, 'error'); const form = init!.body as URLSearchParams;
        assert.equal(form.get('grant_type'), 'password'); assert.equal(form.get('client_id'), 'neo-checks'); assert.equal(form.get('password'), privateCanary);
        logins.push(String(url)); return state.provider && state.directory ? jsonResponse({ access_token: privateCanary }) : jsonResponse({ error: 'invalid_grant', error_description: privateCanary }, 400); } } });
  return { target, graph, request, adapter, state, realm, writeRealm, calls, logins, deployment, service, replicaSets, pods, endpointSlices };
}

test('Neo identity edges use the actual admitted grant, Pod signing-key and Service HTTP paths with native FootPrint events', async t => {
  const f = await fixture(t), recorder = createConnectionRecorder({ id: 'identity-test-recorder' });
  const run = await checkConnections({ graph: f.graph, adapter: f.adapter, recorders: [recorder] });
  assert.equal(run.ok, true);
  assert.deepEqual(Object.values(run.checks).map(check => check.observation!.method).sort(), ['oidc-ldaps-federation', 'kubernetes-pod-jwks-http', 'kubernetes-service-http'].sort());
  assert.deepEqual(run.events.map(event => event.status), ['checking', 'connected', 'checking', 'connected', 'checking', 'connected']);
  assert.equal(recorder.getEvents().length, 6); assert.ok(Object.keys(run.controlDeps).length > 0);
  assert.equal(f.logins.length, 1);
  const commands = f.calls.filter(call => call.args.includes('exec'));
  assert.equal(commands.length, 2);
  assert.deepEqual(JSON.parse(commands[0]!.args.at(-1)!), { url: `http://${f.target.providerAddress}:8080/realms/neo/protocol/openid-connect/certs`, timeoutMs: 3000 });
  assert.ok(f.calls.every(call => !call.args.includes('sh') && call.options.timeoutMs <= 6000));
  assert.ok(!JSON.stringify(run).includes(privateCanary));
});

test('each Neo edge records a measured failure and a new recovered observation without reusing readiness or prior login', async t => {
  const f = await fixture(t);
  for (const [index, key] of [[0, 'directory'], [1, 'jwks'], [2, 'service']] as const) {
    await f.adapter.check(f.request(index)); f.state[key] = false;
    await assert.rejects(f.adapter.check(f.request(index)), error => {
      assert.ok(error instanceof ConnectionCheckError); assert.ok(error.observation); assert.equal(error.observation.details.code,
        index === 0 ? 'federated-login-failed' : index === 1 ? 'jwks-probe-failed' : 'service-probe-failed');
      assert.ok(!JSON.stringify(error).includes(privateCanary));
      if (index === 2) { assert.equal((error.details!.before as any).targetPort, 'http');
        assert.equal((error.details!.probe as any).transport.cause.code, 'ECONNREFUSED'); }
      return true;
    });
    f.state[key] = true; assert.equal((await f.adapter.check(f.request(index))).details.code, 'verified');
  }
  assert.equal(f.logins.length, 3);
  f.state.provider = false; f.state.jwks = false;
  const failed = await checkConnections({ graph: f.graph, adapter: f.adapter });
  assert.equal(failed.ok, false); assert.deepEqual([0, 1, 2].map(index => failed.checks[f.request(index).connectionId]!.status), ['failed', 'failed', 'connected']);
  assert.ok(!JSON.stringify(failed).includes(privateCanary));
  f.state.provider = true; f.state.jwks = true;
  assert.equal((await checkConnections({ graph: f.graph, adapter: f.adapter })).ok, true);
});

test('Neo exact-request and sealed-target admission refuse changes before any network command', async t => {
  const f = await fixture(t);
  for (const change of [
    (request: ConnectionCheckRequest) => { request.connectionId = 'communication:99'; },
    (request: ConnectionCheckRequest) => { request.stack = 'foreign'; },
    (request: ConnectionCheckRequest) => { request.relation.label = 'retargeted'; },
    (request: ConnectionCheckRequest) => { request.from.spec.name = 'foreign'; },
    (request: ConnectionCheckRequest) => { request.to.spec.image = 'foreign'; },
  ]) { const request = structuredClone(f.request(0)); change(request); await assert.rejects(f.adapter.check(request), ConnectionCheckError); }
  const index = f.graph.relations.findIndex(relation => relation.kind === 'order'), relation = f.graph.relations[index]!;
  await assert.rejects(f.adapter.check({ connectionId: `communication:${index}`, stack: f.graph.name, relation,
    from: f.graph.resources.find(resource => resource.id === relation.from)!, to: f.graph.resources.find(resource => resource.id === relation.to)! }), ConnectionCheckError);
  f.state.sealed = false; await assert.rejects(f.adapter.check(f.request(0)), ConnectionCheckError);
  assert.equal(f.calls.length, 0); assert.equal(f.logins.length, 0);
});

test('federation caching, local users, substituted LDAP routes and unowned fixtures cannot establish a connection', async t => {
  const f = await fixture(t), config = f.realm.components['org.keycloak.storage.UserStorageProvider'][0]!.config;
  for (const change of [() => { config.cachePolicy = ['DEFAULT']; }, () => { config.cachePolicy = ['NO_CACHE']; config.connectionUrl = ['ldaps://foreign:1636']; },
    () => { config.connectionUrl = [`ldaps://${f.target.directoryName}:1636`]; (f.realm as any).users = [{ username: 'alice' }]; }]) {
    change(); await f.writeRealm(); await assert.rejects(f.adapter.check(f.request(0)), ConnectionCheckError);
  }
  delete (f.realm as any).users; await f.writeRealm(); f.state.owned = false;
  await assert.rejects(f.adapter.check(f.request(0)), ConnectionCheckError); assert.equal(f.logins.length, 0);
});

test('JWKS probes reject foreign or unready Pod sources and reject identities or sealed targets changing during the request', async t => {
  const f = await fixture(t);
  f.pods[0].status.conditions[0].status = 'False';
  await assert.rejects(f.adapter.check(f.request(1)), ConnectionCheckError);
  f.pods[0].status.conditions[0].status = 'True'; f.replicaSets[0].metadata.ownerReferences[0].uid = 'foreign';
  await assert.rejects(f.adapter.check(f.request(1)), ConnectionCheckError);
  f.replicaSets[0].metadata.ownerReferences[0].uid = 'deployment-uid';
  f.pods[0].spec.containers[0].env.find((entry: any) => entry.name === 'JWKS_URL').value = 'http://foreign';
  await assert.rejects(f.adapter.check(f.request(1)), ConnectionCheckError);
  f.pods[0].spec = structuredClone(f.deployment.spec.template.spec);
  assert.equal(f.calls.filter(call => call.args.includes('exec')).length, 0);
  f.state.afterExec = () => { f.pods[0].metadata.uid = 'replacement-pod'; };
  await assert.rejects(f.adapter.check(f.request(1)), error => error instanceof ConnectionCheckError && error.details?.code === 'identity-changed-during-check');
  f.state.afterExec = () => { f.state.sealed = false; };
  await assert.rejects(f.adapter.check(f.request(1)), error => error instanceof ConnectionCheckError && error.details?.code === 'target-changed-during-check');
});

test('fixed JWKS program performs actual HTTP and validates RSA signing keys without retaining response secrets', async t => {
  const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  let status = 200, stalled = '', body: unknown = { keys: [{ ...publicKey, kid: 'neo-key', alg: 'RS256', use: 'sig' }] };
  const server = createServer((_request, response) => {
    if (stalled === 'headers') return;
    response.writeHead(status, { 'content-type': 'application/json' });
    if (stalled === 'body') { response.write('{"keys":['); return; }
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  t.after(() => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/certs`;
  const run = async (timeoutMs = 1000) => JSON.parse((await promisify(execFile)(process.execPath, ['-e', JWKS_CONNECTION_SCRIPT, JSON.stringify({ url, timeoutMs })], { timeout: 1500 })).stdout);
  assert.equal((await run()).ok, true);
  status = 503; body = { error: privateCanary }; assert.equal((await run()).code, 'jwks-http-failed');
  status = 200; body = { keys: [{ kty: 'RSA', kid: 'neo-key', alg: 'RS256', use: 'sig', n: privateCanary, e: 'AQAB' }] };
  const invalid = await run(); assert.equal(invalid.ok, false); assert.equal(invalid.code, 'jwks-signing-key-missing');
  body = { keys: [], private: privateCanary, padding: 'x'.repeat(65536) }; const large = await run();
  assert.equal(large.code, 'jwks-response-too-large'); assert.ok(!JSON.stringify([invalid, large]).includes(privateCanary));
  body = { keys: [{ ...publicKey, kid: 'neo-key', alg: 'RS256', use: 'sig' }] }; assert.equal((await run()).ok, true);
  for (const mode of ['headers', 'body']) {
    stalled = mode; const started = Date.now(), timeout = await run(200);
    assert.equal(timeout.ok, false); assert.equal(timeout.code, 'jwks-deadline-exceeded');
    assert.ok(timeout.latencyMs >= 180 && timeout.latencyMs < 1000);
    assert.ok(Date.now() - started < 1200, 'The child must flush measured failure and exit before kubectl would time out');
  }
  stalled = ''; assert.equal((await run()).ok, true);
});

test('fixed JWKS program exits promptly after an actual refused connection without losing its failure observation', async () => {
  const reservation = createServer();
  await new Promise<void>((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const started = Date.now();
  const result = JSON.parse((await promisify(execFile)(process.execPath, ['-e', JWKS_CONNECTION_SCRIPT,
    JSON.stringify({ url: `http://127.0.0.1:${port}/certs`, timeoutMs: 200 })], { timeout: 1500 })).stdout);
  assert.equal(result.ok, false); assert.equal(result.code, 'jwks-transport-failed'); assert.equal(result.httpStatus, null);
  assert.ok(result.latencyMs < 1000); assert.ok(Date.now() - started < 1200);
});
