import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { FileStateStore, InfraEngine, ReconcileStrategy, SimulatorAdapter, type ResourceAdapter } from '../src/index.ts';
import { createDeploymentRecorder } from '../src/progress/index.ts';
import { createNeoResourceFlow, type NeoResourceFlowDependencies, type NeoResourceFlowOptions } from '../integration/identity/resource-flow.ts';
import { createNeoAcquisitionGraph } from '../integration/identity/create-acquisition-graph.ts';
import { createNeoConsumerGraph } from '../integration/identity/create-consumer-graph.ts';
import { createIdentityGraph } from '../integration/identity/graph.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { writeNeoFlowJson } from '../integration/identity/resource-flow-files.ts';
import { applyNeoIdentityFault } from '../integration/identity/apply-fault.ts';
import { createNeoIdentityFaultGraph } from '../integration/identity/fault-graph.ts';
import { fingerprint } from '../src/util.ts';
import { MemoryConnectionProfileStore, MemorySecretStore } from '../src/connection-profiles/index.ts';
import { NEO_EXISTING_IDENTITY_ADAPTER } from '../integration/identity/connection-profiles.ts';

const image = (digit: string) => 'sha256:' + digit.repeat(64);
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'neo-resource-flow-'))), directory = join(root, '1234abcd');
  t.after(() => rm(root, { recursive: true, force: true }));
  const target: IdentityTarget = { version: 1, id: '1234abcd', directory, context: 'kind-footprint-iac-recording-aaaa1111',
    kubeconfig: join(root, 'kubeconfig'), namespace: 'footprint-iac-identity-1234abcd', stateDirectory: join(directory, 'state'),
    neoPort: 61660, providerPort: 61661, ldapPort: 61662, issuer: 'http://127.0.0.1:61661/realms/neo',
    providerName: 'footprint-identity-1234abcd-provider', directoryName: 'footprint-identity-1234abcd-directory',
    fixtureDigest: 'f'.repeat(64), images: { nodeImage: image('1'), pythonImage: image('2'), ldapImage: image('3'), providerImage: image('4') } };
  const targetPath = join(directory, 'target.json'); await writeNeoFlowJson(targetPath, target);
  const original = await readFile(targetPath, 'utf8');
  const simulator = new SimulatorAdapter({ file: join(root, 'provider.json') });
  const adapter = (name: string): ResourceAdapter => ({ name, scope: simulator.scope + '/' + name, supportsSafeRetry: true,
    observe: simulator.observe.bind(simulator), apply: simulator.apply.bind(simulator), remove: simulator.remove.bind(simulator),
    waitReady: simulator.waitReady.bind(simulator) });
  const engine: typeof import('../integration/identity/engine.ts').identityEngine = () => {
    const recorder = createDeploymentRecorder();
    return { recorder, engine: new InfraEngine({ adapters: [adapter('local-identity-fixture'), adapter('kubernetes')],
      store: new FileStateStore(target.stateDirectory), strategy: new ReconcileStrategy(1),
      traceDirectory: join(directory, 'deployment-traces'), recorders: [recorder], chartObservers: [recorder] }) };
  };
  const observed = { find: 0, discovery: 0, forward: 0, connections: 0, access: 0, replaced: false, stopped: false };
  const dependencies: NeoResourceFlowDependencies = {
    engine, loadTarget: async path => JSON.parse(await readFile(path!, 'utf8')) as IdentityTarget,
    async observe() {
      observed.find++;
      const graph = createNeoAcquisitionGraph(target);
      for (const resource of graph.resources) {
        const state = await simulator.observe(resource, { stack: graph.name, operationId: 'reference-check' });
        if (!state.exists || !state.owned) throw Error('Missing existing identity services');
      }
      return { directory: { id: 'a'.repeat(64), name: target.directoryName, running: true, address: '172.20.0.2' },
        provider: { id: (observed.replaced ? 'c' : 'b').repeat(64), name: target.providerName, running: !observed.stopped, address: '172.20.0.3' } };
    },
    discoveryFetch: async () => {
      observed.discovery++; return Response.json({ issuer: target.issuer,
        jwks_uri: target.issuer + '/protocol/openid-connect/certs', authorization_endpoint: target.issuer + '/protocol/openid-connect/auth',
        token_endpoint: target.issuer + '/protocol/openid-connect/token' });
    },
    async ensureForward(selected) { observed.forward++; assert.equal(selected.neoPort, target.neoPort); },
    async connections() { return { async check(request) { observed.connections++;
      assert.equal(observed.forward, 1); return { method: 'test-transport', target: request.connectionId, observedAt: Date.now(), latencyMs: 1, details: { status: 200 } };
    } }; },
    async identity() { return { id: 'test-access', async check(request) {
      observed.access++; assert.equal(observed.connections, 3); return { verdict: request.expected, observedAt: Date.now(), latencyMs: 1 };
    } }; },
  };
  const open = (options: NeoResourceFlowOptions) => createNeoResourceFlow(targetPath, options, dependencies);
  return { target, targetPath, directory, original, simulator, observed, engine, open, dependencies,
    adapters: [adapter('local-identity-fixture'), adapter('kubernetes')] };
}

test('Neo consumes user-entered existing connection details, pins them across a native human pause and keeps credentials out of evidence', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  assert.equal((await baseline.engine.apply(createNeoAcquisitionGraph(f.target))).ok, true); f.simulator.calls.length = 0;
  const secret = 'private-validation-password-never-record-me', requests: { url: string; method: string }[] = [];
  f.dependencies.connectionProfileStores = { profiles: new MemoryConnectionProfileStore(), secrets: new MemorySecretStore() };
  f.dependencies.discoveryFetch = async (input, init) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/protocol/openid-connect/token')) {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      assert.equal(body.get('client_id'), 'neo-checks'); assert.equal(body.get('username'), 'alice');
      return body.get('password') === secret ? Response.json({ access_token: 'private-ephemeral-token-never-record-me' })
        : Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 });
    }
    return Response.json({ issuer: f.target.issuer, jwks_uri: f.target.issuer + '/protocol/openid-connect/certs',
      authorization_endpoint: f.target.issuer + '/protocol/openid-connect/auth', token_endpoint: f.target.issuer + '/protocol/openid-connect/token' });
  };
  const options: NeoResourceFlowOptions = { mode: 'existing', profiles: 'user', details: 'human', id: 'user-entered-existing' };
  const flow = await f.open(options), registry = flow.connectionProfiles!;
  assert.deepEqual(await registry.list(), []);
  const beforeMissing = f.observed.find;
  await assert.rejects(flow.workflow.start());
  assert.equal(f.observed.find, beforeMissing, 'missing locator is rejected before Find');
  const registration = { adapterId: NEO_EXISTING_IDENTITY_ADAPTER, label: 'Company sign-in service',
    config: { issuer: f.target.issuer, clientId: 'neo-checks', username: 'alice' }, secrets: { password: secret } };
  await assert.rejects(registry.register({ ...registration, config: { ...registration.config, issuer: 'http://169.254.169.254/metadata' } }));
  assert.equal(requests.length, 0, 'unapproved destinations are rejected before network access');
  await assert.rejects(registry.register({ ...registration, secrets: { password: 'wrong' } }), error => {
    assert.ok(!String(error).includes(secret)); return true;
  });
  assert.deepEqual(await registry.list(), []);
  const profile = await registry.register(registration);
  assert.equal(profile.config.issuer, registration.config.issuer); assert.ok(profile.secretRefs.password);
  assert.ok(!JSON.stringify(profile).includes(secret));
  assert.deepEqual(await registry.test(profile.id), { profileId: profile.id, ok: true });
  const paused = await flow.workflow.start({ profileId: profile.id });
  assert.equal(paused.status, 'paused'); assert.equal(paused.selectedProfileId, profile.id);
  assert.equal(paused.resource?.physicalId.length, 64); assert.equal(paused.pause?.profiles[0]?.id, profile.id);
  assert.equal(f.simulator.calls.length, 0);
  const otherProfile = await registry.register({ ...registration, label: 'Another saved connection' });
  await assert.rejects(flow.workflow.resume({ pauseToken: paused.pause!.token, profileId: otherProfile.id }));
  assert.equal((await flow.workflow.snapshot()).status, 'paused', 'another registration does not replace the pinned profile');
  const reopened = await f.open(options);
  const complete = await reopened.workflow.resume({ pauseToken: paused.pause!.token, profileId: profile.id });
  assert.equal(complete.status, 'passed'); assert.equal(complete.details?.profileId, profile.id);
  assert.equal(complete.details?.endpoint, registration.config.issuer);
  assert.equal(complete.details?.credentialRef, 'profile-' + profile.id);
  assert.equal(complete.segments[1]?.resumedFromRunId, complete.segments[0]?.runId);
  assert.deepEqual(f.simulator.calls.map(call => call.id), ['neo-namespace', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.ok(f.simulator.calls.every(call => !call.id.startsWith('identity-')), 'Find never recreates or changes its source');
  const files = await readdir(reopened.directory, { recursive: true });
  for (const file of files.filter(file => /\.jsonl?$/.test(file))) {
    const recorded = await readFile(join(reopened.directory, file), 'utf8');
    assert.ok(!recorded.includes(secret), file); assert.ok(!recorded.includes('private-ephemeral-token-never-record-me'), file);
  }
  assert.ok(requests.some(request => request.url === registration.config.issuer + '/protocol/openid-connect/token'));
});

test('user-profile rechecks retain failed and recovered measurements when the admitted sign-in service is unavailable', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  assert.equal((await baseline.engine.apply(createNeoAcquisitionGraph(f.target))).ok, true); f.simulator.calls.length = 0;
  let available = true, authenticationRequests = 0;
  f.dependencies.connectionProfileStores = { profiles: new MemoryConnectionProfileStore(), secrets: new MemorySecretStore() };
  f.dependencies.discoveryFetch = async input => {
    authenticationRequests++;
    if (!available) throw Error('The admitted sign-in service is offline');
    return String(input).endsWith('/token') ? Response.json({ access_token: 'private-transient-validation-token' })
      : Response.json({ issuer: f.target.issuer, jwks_uri: f.target.issuer + '/protocol/openid-connect/certs',
        authorization_endpoint: f.target.issuer + '/protocol/openid-connect/auth', token_endpoint: f.target.issuer + '/protocol/openid-connect/token' });
  };
  f.dependencies.connections = async () => ({ async check(request) {
    if (!available) throw Error('Measured connection unavailable');
    return { method: 'test-transport', target: request.connectionId, observedAt: Date.now(), latencyMs: 1, details: { status: 200 } };
  } });
  f.dependencies.identity = async () => ({ id: 'measured-access', async check(request) {
    return { verdict: available ? request.expected : 'unavailable', observedAt: Date.now(), latencyMs: 1 };
  } });
  const flow = await f.open({ mode: 'existing', profiles: 'user', id: 'profile-outage-observation' });
  const profile = await flow.connectionProfiles!.register({ adapterId: NEO_EXISTING_IDENTITY_ADAPTER, label: 'Existing sign-in',
    config: { issuer: f.target.issuer, clientId: 'neo-checks', username: 'alice' }, secrets: { password: 'private-validation-password' } });
  assert.equal((await flow.workflow.start({ profileId: profile.id })).status, 'passed');
  const mutations = structuredClone(f.simulator.calls), originalParent = await flow.workflow.snapshot();
  const originalAuthenticationRequests = authenticationRequests;
  available = false; f.observed.stopped = true;
  const failedConnections = await flow.recheckConnections(), failedIdentity = await flow.recheckIdentity();
  assert.equal(failedConnections.ok, false); assert.equal(failedIdentity.ok, false);
  assert.equal(Object.keys(failedConnections.checks).length, 3); assert.equal(Object.keys(failedIdentity.checks).length, 7);
  assert.ok(Object.values(failedConnections.checks).every(check => check.status === 'failed'));
  assert.ok(Object.values(failedIdentity.checks).every(check => check.status === 'failed'));
  assert.equal(authenticationRequests, originalAuthenticationRequests, 'binding admission does not preempt measured checks with a profile-authentication request');
  available = true; f.observed.stopped = false;
  const recoveredConnections = await flow.recheckConnections(), recoveredIdentity = await flow.recheckIdentity();
  assert.equal(recoveredConnections.ok, true); assert.equal(recoveredIdentity.ok, true);
  assert.notEqual(failedConnections.runId, recoveredConnections.runId); assert.notEqual(failedIdentity.runId, recoveredIdentity.runId);
  const retained = await flow.observation.snapshot();
  assert.equal(retained.connections.length, 3); assert.equal(retained.identities.length, 3);
  assert.deepEqual(f.simulator.calls, mutations); assert.deepEqual(await flow.workflow.snapshot(), originalParent);
});

test('Neo create flow records two identity creates, then separately configures four consumer resources and verifies actual workflow results', async t => {
  const f = await fixture(t), flow = await f.open({ mode: 'create' });
  const events: { stage: string; status: string; mutations: string[] }[] = [];
  const unsubscribe = flow.workflow.subscribe(state => { const event = state.events.at(-1);
    if (event) events.push({ stage: event.stageId, status: event.status, mutations: f.simulator.calls.map(call => call.id) }); });
  await flow.workflow.start(); unsubscribe();
  const state = await flow.workflow.snapshot();
  assert.equal(state.status, 'passed'); assert.deepEqual(state.stages.map(stage => stage.status), ['passed', 'passed', 'passed', 'passed']);
  assert.deepEqual(f.simulator.calls.map(call => call.id), ['identity-directory', 'identity-provider', 'neo-namespace', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.ok(events.some(event => event.stage === 'acquire' && event.status === 'passed'
    && event.mutations.join(',') === 'identity-directory,identity-provider'));
  assert.equal(f.observed.forward, 1); assert.equal(f.observed.connections, 3); assert.equal(f.observed.access, 7);
  assert.ok(state.resource?.receipt?.runId); assert.ok(state.connection?.runId); assert.notEqual(state.resource?.receipt?.runId, state.connection?.runId);
  assert.equal(state.verification?.checks.length, 10); assert.equal(state.verification?.ok, true);
  const inventory = await new FileStateStore(f.target.stateDirectory).load(flow.graph.name);
  assert.equal(Object.keys(inventory.resources).length, 6, 'partial Connect does not discard the source inventory');
  const template = (inventory.resources['neo-app']!.resource.spec.spec as any).template.spec;
  assert.ok(template.containers[0].env.some((entry: any) => entry.name === 'OIDC_AUTHORITY' && entry.value === f.target.issuer));
  assert.ok(template.containers[0].env.some((entry: any) => entry.name === 'SEO_ACCESS_POLICY_FILE'));
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original, 'flow does not rewrite canonical target bindings');
  const runs = await readdir(join(flow.directory, 'infra')); assert.equal(runs.length, 2);
  const native = await Promise.all(runs.map(async name => JSON.parse(await readFile(join(flow.directory, 'infra', name), 'utf8'))));
  assert.equal(native.find(run => run.phase === 'connect').result.plan.operations.length, 4);
  assert.ok(native.find(run => run.phase === 'connect').result.plan.operations.every((operation: any) => operation.resource.provider === 'kubernetes'));
});

test('Neo Find references an existing identity pair without source mutations, then uses the same real Connect stage to create its consumer', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  assert.equal((await baseline.engine.apply(createNeoAcquisitionGraph(f.target))).ok, true); f.simulator.calls.length = 0;
  const flow = await f.open({ mode: 'existing' }); await flow.workflow.start();
  const state = await flow.workflow.snapshot();
  assert.equal(state.status, 'passed'); assert.equal(state.mode, 'existing');
  assert.equal(state.resource?.receipt, undefined, 'Find must not claim it created the referenced services');
  assert.deepEqual(f.simulator.calls.map(call => call.id), ['neo-namespace', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.ok(f.simulator.calls.every(call => !call.id.startsWith('identity-')));
  assert.equal(f.observed.connections, 3); assert.equal(f.observed.access, 7);
});

test('Neo waits for a fixed connection profile, reopens its native checkpoint, then connects without repeating acquisition', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  await baseline.engine.apply(createNeoAcquisitionGraph(f.target)); f.simulator.calls.length = 0;
  const flow = await f.open({ mode: 'existing', details: 'human' }); await flow.workflow.start();
  const waiting = await flow.workflow.snapshot();
  assert.equal(waiting.status, 'paused'); assert.equal(waiting.stages[0]?.status, 'passed');
  assert.equal(waiting.stages[1]?.status, 'waiting'); assert.ok(waiting.pause?.token);
  assert.deepEqual([...f.simulator.calls], []); assert.equal(f.observed.discovery, 0); assert.equal(f.observed.forward, 0);
  const reopened = await f.open({ mode: 'existing', details: 'human' });
  await reopened.workflow.resume({ pauseToken: waiting.pause!.token, profileId: flow.profileId });
  const state = await reopened.workflow.snapshot();
  assert.equal(state.status, 'passed'); assert.equal(state.executionId, waiting.executionId);
  assert.ok(state.segments.length >= 2); assert.equal(f.observed.discovery, 1);
  assert.deepEqual(f.simulator.calls.map(call => call.id), ['neo-namespace', 'neo-access-policy', 'neo-app', 'neo-service']);
  assert.equal(f.observed.access, 7);
});

test('missing or replaced existing identity is refused before any consumer mutation', async t => {
  const f = await fixture(t), missing = await f.open({ mode: 'existing' });
  await missing.workflow.start(); assert.equal((await missing.workflow.snapshot()).status, 'failed'); assert.deepEqual(f.simulator.calls, []);
  const baseline = f.engine(f.target); await baseline.engine.apply(createNeoAcquisitionGraph(f.target)); f.simulator.calls.length = 0;
  const flow = await f.open({ mode: 'existing', details: 'human', id: 'replacement-check' }); await flow.workflow.start();
  const waiting = await flow.workflow.snapshot(); f.observed.replaced = true;
  await flow.workflow.resume({ pauseToken: waiting.pause!.token, profileId: flow.profileId });
  assert.equal((await flow.workflow.snapshot()).status, 'failed'); assert.deepEqual(f.simulator.calls, []);
  assert.equal(f.observed.forward, 0); assert.equal(f.observed.connections, 0);
});

test('consumer graph has no authority to create or modify its referenced identity services', async t => {
  const f = await fixture(t), consumer = createNeoConsumerGraph(f.target), full = createIdentityGraph(f.target, { includeNeo: true });
  assert.equal(consumer.name, full.name); assert.equal(consumer.resources.length, 4);
  assert.ok(consumer.resources.every(resource => resource.provider === 'kubernetes' && !resource.id.startsWith('identity-')));
  assert.ok(consumer.resources.every(resource => resource.dependsOn?.every(id => !id.startsWith('identity-')) ?? true));
  assert.equal(consumer.resources.find(resource => resource.id === 'neo-app')!.spec.spec !== undefined, true);
  const endpoint = 'https://identity.example.test/realms/company';
  const bound = createNeoConsumerGraph(f.target, { endpoint });
  const containers = (bound.resources.find(resource => resource.id === 'neo-app')!.spec.spec as any).template.spec.containers;
  for (const name of ['JWT_ISSUER', 'OIDC_AUTHORITY']) {
    assert.equal(containers.find((container: any) => container.name === 'node').env.find((entry: any) => entry.name === name).value, endpoint);
  }
  assert.notEqual(bound.digest, consumer.digest, 'a different resolved endpoint changes the pinned consumer plan');
});

test('a failed Connect retains its exact failed native child receipt and never mutates the referenced source', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  await baseline.engine.apply(createNeoAcquisitionGraph(f.target)); f.simulator.calls.length = 0;
  f.simulator.faults.failBeforeApply = new Set(['neo-app']);
  const flow = await f.open({ mode: 'existing', id: 'failed-connect' }); await flow.workflow.start();
  const state = await flow.workflow.snapshot();
  assert.equal(state.status, 'failed'); assert.equal(state.failure?.stageId, 'connect');
  assert.equal(state.failure?.code, 'native-connect-failed'); assert.ok(state.failure?.receipt?.runId);
  assert.ok(state.failure?.receipt?.evidencePath); assert.equal(state.connection, undefined);
  assert.ok(f.simulator.calls.every(call => !call.id.startsWith('identity-')));
  assert.equal(f.observed.connections, 0); assert.equal(f.observed.access, 0);
  const child = JSON.parse(await readFile(join(flow.directory, 'infra', state.failure!.receipt!.runId + '.json'), 'utf8'));
  assert.equal(child.phase, 'connect'); assert.equal(child.result.ok, false);
  assert.equal(child.result.evidencePath, state.failure?.receipt?.evidencePath);
  assert.equal(child.result.runId, state.failure?.receipt?.runId);
});

test('a forward failure preserves successful consumer configuration evidence without publishing private adapter errors', async t => {
  const f = await fixture(t), secret = 'private-test-password-must-stay-out-of-recordings';
  f.dependencies.ensureForward = async () => { throw Error(secret); };
  const flow = await f.open({ mode: 'create', id: 'failed-forward' }); await flow.workflow.start();
  const state = await flow.workflow.snapshot();
  assert.equal(state.status, 'failed'); assert.equal(state.failure?.code, 'consumer-access-unavailable');
  const child = JSON.parse(await readFile(join(flow.directory, 'infra', state.failure!.receipt!.runId + '.json'), 'utf8'));
  assert.equal(child.result.ok, true, 'forward failure does not rewrite the real successful resource outcome');
  assert.equal(state.failure?.receipt?.evidencePath, child.result.evidencePath);
  assert.equal(f.observed.connections, 0); assert.equal(f.observed.access, 0);
  assert.ok(!JSON.stringify(state).includes(secret));
  for (const segment of state.segments) assert.ok(!(await readFile(segment.evidencePath, 'utf8')).includes(secret));
});

test('successful probes cannot pass the parent flow when the acquired identity changes during verification', async t => {
  const f = await fixture(t), identity = f.dependencies.identity!;
  f.dependencies.identity = async target => {
    const adapter = await identity(target);
    return { id: adapter.id, async check(request) {
      const result = await adapter.check(request); f.observed.replaced = true; return result;
    } };
  };
  const flow = await f.open({ mode: 'create', id: 'verify-identity-guard' }); await flow.workflow.start();
  const state = await flow.workflow.snapshot();
  assert.equal(state.status, 'failed'); assert.equal(state.failure?.stageId, 'verify');
  assert.equal(state.failure?.code, 'identity-changed-during-verification');
  assert.equal(state.failure?.receipt?.id, 'neo-connections');
  assert.equal(state.verification, undefined, 'a successful child probe does not authorize a changed parent resource');
  assert.equal(f.observed.connections, 3); assert.equal(f.observed.access, 7);
});

test('owned provider faults accept the exact completed separated consumer inventory and preserve its dependency contract', async t => {
  const f = await fixture(t), fixtureRoot = dirname(f.target.directory);
  // Keep the normal identity target validator active; only its external transport is a local test seam.
  f.target.kubeconfig = resolve(fixtureRoot, '../..', '.artifacts/neo/fresh/aaaa1111/kubeconfig');
  await writeNeoFlowJson(f.targetPath, f.target);
  const flow = await f.open({ mode: 'create', id: 'separated-fault-compatibility' });
  await flow.workflow.start(); assert.equal((await flow.workflow.snapshot()).status, 'passed');
  const store = new FileStateStore(f.target.stateDirectory), before = await store.load(flow.graph.name);
  const app = before.resources['neo-app']!.resource;
  assert.deepEqual(app.dependsOn, ['neo-access-policy', 'neo-namespace']);
  const options = { fixtureRoot, loadTarget: f.dependencies.loadTarget, adapters: f.adapters, store };
  f.simulator.calls.length = 0;
  for (const action of ['provider-down', 'provider-restore'] as const) {
    const result = await applyNeoIdentityFault(f.target, action, options);
    assert.equal(result.result.ok, true); assert.equal(result.resourceId, 'identity-provider');
    assert.deepEqual(result.result.plan.operations.filter(operation => operation.action !== 'noop').map(operation => operation.resource.id), ['identity-provider']);
    const saved = await store.load(flow.graph.name);
    assert.deepEqual(saved.resources['neo-app'], before.resources['neo-app'], 'a provider fault must not reintroduce the dependency handled by the parent flow');
    assert.equal(saved.resources['identity-provider']!.physicalId, before.resources['identity-provider']!.physicalId);
  }
  assert.deepEqual(f.simulator.calls.map(call => call.id), ['identity-provider', 'identity-provider']);
  const restored = await store.load(flow.graph.name);
  for (const mutate of [
    (resource: typeof app) => { resource.dependsOn = ['neo-namespace']; },
    (resource: typeof app) => { resource.dependsOn = []; },
    (resource: typeof app) => { resource.spec.unexpected = true; },
  ]) {
    const tampered = structuredClone(restored), selected = tampered.resources['neo-app']!;
    mutate(selected.resource); selected.fingerprint = fingerprint(selected.resource.spec);
    assert.throws(() => createNeoIdentityFaultGraph(f.target, tampered, 'provider-down'), /differs/);
  }
});

test('Neo observer streams actual two/four resource charts and native checks, then reopens without provider reads or effects', async t => {
  const f = await fixture(t), flow = await f.open({ mode: 'create', id: 'observable-create' });
  const frames: Awaited<ReturnType<typeof flow.observation.snapshot>>[] = [];
  const unsubscribe = flow.observation.subscribe(value => { frames.push(value); assert.ok(Object.isFrozen(value)); });
  flow.observation.subscribe(() => { throw Error('viewer failed'); });
  const initial = await flow.observation.snapshot();
  assert.equal(initial.parent.executionId, null); assert.deepEqual(initial.deployments, []);
  assert.deepEqual(initial.connections, []); assert.deepEqual(initial.identities, []);
  await flow.workflow.start(); unsubscribe();
  const final = await flow.observation.snapshot();
  assert.equal(final.parent.status, 'passed'); assert.ok(final.subscriberFailures > 0);
  assert.deepEqual(final.deployments.map(value => [value.phase, value.snapshot.chart?.resources.length]), [['acquire', 2], ['connect', 4]]);
  assert.ok(final.deployments.every(value => value.snapshot.runId !== final.parent.segments[0]?.runId));
  assert.ok(frames.some(frame => frame.deployments.some(run => run.phase === 'acquire' && run.snapshot.events.some(event => event.status === 'deploying') && !run.result)));
  assert.ok(frames.some(frame => frame.connections.some(run => run.snapshot.events.some(event => event.status === 'checking') && !run.result)));
  assert.ok(frames.some(frame => frame.identities.some(run => run.snapshot.events.some(event => event.status === 'checking') && !run.result)));
  for (const child of [...final.deployments, ...final.connections, ...final.identities]) {
    assert.equal(child.executionId, final.parent.executionId); assert.equal(child.definitionDigest, final.parent.definitionDigest);
    assert.equal(child.origin, 'live'); assert.ok(child.result?.runId); assert.equal(child.result?.traceFlushed, true);
  }
  assert.equal(final.source?.physicalId, final.parent.resource?.physicalId);
  assert.deepEqual(final.source?.resources.map(value => value.resourceId), ['identity-directory', 'identity-provider']);
  assert.ok(final.source?.observedAt); assert.ok(final.source?.parentAcquire?.runtimeStageId);
  assert.equal(final.source?.parentAcquire?.runId, final.parent.segments[0]?.runId);
  assert.equal(final.retainedEvidence, 'complete');
  const before = structuredClone({ counters: f.observed, calls: f.simulator.calls });
  const reopened = await f.open({ mode: 'create', id: 'observable-create' });
  const restored = await reopened.observation.snapshot();
  assert.equal(restored.retainedEvidence, 'complete'); assert.deepEqual(restored.source, final.source);
  assert.deepEqual(restored.deployments.map(value => value.snapshot), final.deployments.map(value => value.snapshot));
  assert.deepEqual(restored.connections.map(value => value.snapshot), final.connections.map(value => value.snapshot));
  assert.deepEqual(restored.identities.map(value => value.snapshot), final.identities.map(value => value.snapshot));
  assert.ok([...restored.deployments, ...restored.connections, ...restored.identities].every(value => value.origin === 'evidence'));
  assert.deepEqual({ counters: f.observed, calls: f.simulator.calls }, before, 'view/reopen cannot perform even a provider read');
});

test('Neo Find observer retains measured source references across a human restart and never invents acquisition apply', async t => {
  const f = await fixture(t), baseline = f.engine(f.target);
  await baseline.engine.apply(createNeoAcquisitionGraph(f.target)); f.simulator.calls.length = 0;
  const flow = await f.open({ mode: 'existing', details: 'human', id: 'observable-find' });
  await assert.rejects(flow.recheckConnections(), /Complete/);
  await flow.workflow.start();
  const waiting = await flow.observation.snapshot();
  assert.equal(waiting.parent.status, 'paused'); assert.deepEqual(waiting.deployments, []);
  assert.equal(waiting.source?.mode, 'existing'); assert.ok(waiting.source?.parentAcquire?.runtimeStageId);
  assert.equal(waiting.source?.parentAcquire?.runId, waiting.parent.segments[0]?.runId);
  const reads = f.observed.find, reopened = await f.open({ mode: 'existing', details: 'human', id: 'observable-find' });
  const restored = await reopened.observation.snapshot();
  assert.equal(f.observed.find, reads); assert.deepEqual(restored.source, waiting.source);
  await reopened.workflow.resume({ pauseToken: waiting.parent.pause!.token, profileId: flow.profileId });
  const complete = await reopened.observation.snapshot();
  assert.equal(complete.parent.status, 'passed'); assert.equal(complete.deployments.length, 1);
  assert.equal(complete.deployments[0]?.phase, 'connect'); assert.equal(complete.deployments[0]?.snapshot.chart?.resources.length, 4);
  assert.deepEqual(complete.source, waiting.source, 'resume does not claim a new acquisition or alter its observed time');
});

test('fixed Neo rechecks stream failed and recovered checks under distinct runs without rerunning or changing the parent', async t => {
  const f = await fixture(t); let failed = false;
  f.dependencies.connections = async () => ({ async check(request) {
    if (failed) throw Error('private-provider-error-should-never-reach-browser');
    return { method: 'oidc-ldaps-federation', target: 'ldaps://identity.example.test:1636', observedAt: Date.now(), latencyMs: 1, details: {} };
  } });
  f.dependencies.identity = async () => ({ id: 'observed-identity', async check(request) {
    return { verdict: failed ? 'unavailable' : request.expected, observedAt: Date.now(), latencyMs: 1 };
  } });
  const flow = await f.open({ mode: 'create', id: 'observable-rechecks' }); await flow.workflow.start();
  const parent = await flow.workflow.snapshot(), calls = structuredClone(f.simulator.calls);
  failed = true; f.observed.stopped = true;
  assert.equal((await flow.recheckConnections()).ok, false); assert.equal((await flow.recheckIdentity()).ok, false);
  failed = false; f.observed.stopped = false;
  assert.equal((await flow.recheckConnections()).ok, true); assert.equal((await flow.recheckIdentity()).ok, true);
  const state = await flow.observation.snapshot();
  assert.deepEqual(await flow.workflow.snapshot(), parent); assert.deepEqual(f.simulator.calls, calls);
  for (const checks of [state.connections, state.identities]) {
    assert.equal(checks.length, 3); assert.deepEqual(checks.map(value => value.purpose), ['verify', 'recheck', 'recheck']);
    assert.deepEqual(checks.map(value => value.result?.ok), [true, false, true]);
    assert.equal(new Set(checks.map(value => value.snapshot.runId)).size, 3);
  }
  assert.ok(!JSON.stringify(state).includes('private-provider-error'));
  const before = structuredClone(f.observed), reopened = await f.open({ mode: 'create', id: 'observable-rechecks' });
  const restored = await reopened.observation.snapshot();
  assert.equal(restored.retainedEvidence, 'complete'); assert.equal(restored.connections.length, 3); assert.equal(restored.identities.length, 3);
  assert.deepEqual(f.observed, before);
  f.observed.replaced = true;
  await assert.rejects(reopened.recheckConnections(), /replaced/);
  assert.equal((await reopened.observation.snapshot()).connections.length, 3);
});

test('tampered retained child evidence stays unknown and never invokes providers on reopening', async t => {
  const f = await fixture(t), flow = await f.open({ mode: 'create', id: 'observable-tamper' });
  await flow.workflow.start();
  const state = await flow.observation.snapshot(), native = state.deployments[0]!;
  const path = join(flow.directory, 'infra', native.result!.runId + '.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.events[0].resourceId = 'invented-resource'; await writeNeoFlowJson(path, saved);
  const before = structuredClone({ counters: f.observed, calls: f.simulator.calls });
  const reopened = await f.open({ mode: 'create', id: 'observable-tamper' });
  const observed = await reopened.observation.snapshot();
  assert.equal(observed.retainedEvidence, 'incomplete'); assert.deepEqual(observed.deployments, []);
  assert.deepEqual({ counters: f.observed, calls: f.simulator.calls }, before);
});

test('legacy parent-pinned native evidence rehydrates while missing source lookup facts remain unknown', async t => {
  const f = await fixture(t), flow = await f.open({ mode: 'create', id: 'observable-legacy' });
  await flow.workflow.start();
  await rm(join(flow.directory, 'observer.json'));
  const before = structuredClone({ counters: f.observed, calls: f.simulator.calls });
  const reopened = await f.open({ mode: 'create', id: 'observable-legacy' }), state = await reopened.observation.snapshot();
  assert.equal(state.retainedEvidence, 'complete'); assert.equal(state.source, undefined);
  assert.equal(state.deployments.length, 2); assert.equal(state.connections.length, 1); assert.equal(state.identities.length, 1);
  assert.ok([...state.deployments, ...state.connections, ...state.identities].every(value => value.origin === 'evidence'));
  assert.deepEqual({ counters: f.observed, calls: f.simulator.calls }, before);
});
