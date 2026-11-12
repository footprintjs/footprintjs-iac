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
  const observed = { find: 0, discovery: 0, forward: 0, connections: 0, access: 0, replaced: false };
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
        provider: { id: (observed.replaced ? 'c' : 'b').repeat(64), name: target.providerName, running: true, address: '172.20.0.3' } };
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
