import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fingerprint } from '../src/util.ts';
import { hostFactsDigest } from '../src/platform-access/facts.ts';
import type { HostAccessTransport, HostFactsSnapshot } from '../src/platform-access/types.ts';
import { assessBootstrapStrategy, conservativeClusterBootstrapStrategy, createKubeadmHostAction, ExistingClusterAdapter,
  KubeadmClusterAdapter, KUBEADM_ACTION_COMPLETE, preparationAssessmentDigest, readBootstrapPlan, sealBootstrapPlan } from '../src/platform-bootstrap/index.ts';
import type { BootstrapContext, BootstrapIntent, ClusterConnectionPort, HostPreparationAssessment, HostPreparationPort } from '../src/platform-bootstrap/types.ts';
import { readBootstrapIntent } from '../src/platform-bootstrap/data.ts';

const context = (): BootstrapContext => ({ executionId: 'bootstrap-test', operationId: 'operation-1', completedActionIds: [] });
const identity = (id: string) => fingerprint({ machine: id });
function facts(id: string): HostFactsSnapshot {
  const value: Omit<HostFactsSnapshot, 'digest'> = { version: 1, kind: 'host-facts', host: { id, scope: `managed-${id}`, profileId: `ssh-${id}` }, observedAt: Date.now(), status: 'partial',
    identityDigest: identity(id), os: { family: 'linux', distribution: 'ubuntu', version: '24.04', kernel: '6.8.0' }, architecture: 'amd64', cpuCount: 4,
    memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, disk: { path: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 80 * 1024 ** 3 }, privilege: 'root',
    tools: { kubeadm: { status: 'installed', version: '1.37.0' }, kubelet: { status: 'installed', version: '1.37.0' }, kubectl: { status: 'installed', version: '1.37.0' }, containerd: { status: 'installed', version: '2.2.0' } },
    kubernetes: { status: 'unknown' } };
  return { ...value, digest: hostFactsDigest(value) };
}
function changeFacts(value: HostFactsSnapshot, edit: (value: HostFactsSnapshot) => void): HostFactsSnapshot {
  const next = structuredClone(value); edit(next); const { digest: _digest, ...snapshot } = next; next.digest = hostFactsDigest(snapshot); return next;
}
function fixture() {
  const intent: BootstrapIntent = { id: 'company-cluster', mode: 'create', topology: { version: '1.37.0', nodes: [{ hostId: 'control', role: 'control-plane' }, { hostId: 'worker', role: 'worker' }], podNetworkCidr: '10.244.0.0/16', serviceNetworkCidr: '10.96.0.0/12' } };
  const resource = { id: intent.id, kind: 'kubernetes-cluster', physicalId: 'kube-system-uid-1', scope: 'registered-target' };
  const state = { initialized: false, network: false, joined: false, unknown: false, thrown: false, preparation: 'ready' as HostPreparationAssessment['status'], passed: true, stale: false, mutation: false };
  const calls: { id: string; ctx: any }[] = [];
  const transport = (id: string): HostAccessTransport => ({ id: `transport-${id}`, host: facts(id).host,
    actions: () => [id === 'control' ? 'init-control' : 'join-worker', ...(id === 'control' ? ['network-control'] : []), `prepare-${id}`].map(id => ({ id, digest: fingerprint({ action: id }), effect: 'mutating' })),
    run: async (id, ctx) => {
      calls.push({ id, ctx });
      if (state.thrown) throw new Error('private-token-never-record');
      if (id === 'init-control') state.initialized = true;
      if (id === 'network-control') state.network = true;
      if (id === 'join-worker') state.joined = true;
      if (id.startsWith('prepare-')) return { stdout: '' };
      return { stdout: KUBEADM_ACTION_COMPLETE + '\n' };
    } });
  const transports = [transport('control'), transport('worker')];
  const preparation: HostPreparationPort = { id: 'site-preparer', recipeDigest: fingerprint('reviewed-recipe'), inspect: async (fact, _intent, ctx) => {
    const value: Omit<HostPreparationAssessment, 'digest'> = { hostId: fact.host.id, identityDigest: fact.identityDigest!, recipeDigest: preparation.recipeDigest,
      status: state.preparation, observedAt: state.stale ? 1 : Date.now(), actions: [{ id: `prepare-${fact.host.id}`, hostId: fact.host.id, phase: 'prepare', actionDigest: fingerprint({ action: `prepare-${fact.host.id}` }) }],
      checks: ['node-cleanliness', 'network', 'configuration', 'cni-artifacts', 'packages', 'runtime'].map(id => ({ id, passed: state.passed })) };
    return { ...value, digest: preparationAssessmentDigest(value) };
  } };
  const connection: ClusterConnectionPort = { inspect: async () => state.unknown ? { status: 'unknown' } : state.initialized ? { status: 'present', resource, platformVersion: intent.topology.version } : { status: 'absent' },
    publishAccess: async () => ({ profileId: 'kubernetes-access-new' }),
    verify: async () => ({ ok: state.initialized && state.network && state.joined, checks: [
      { id: 'api', passed: state.initialized }, { id: 'nodes-ready', passed: state.joined }, { id: 'system-pods-ready', passed: state.network }, { id: 'cni-ready', passed: state.network } ] }) };
  const options = { id: 'kubeadm-site', scope: resource.scope, intent, hosts: transports.map(transport => ({ hostId: transport.host.id, transport, preparation,
    ...(transport.host.id === 'control' ? { initializeActionId: 'init-control' } : { joinActionId: 'join-worker' }) })), networkActionId: 'network-control', connection };
  return { intent, resource, state, calls, transports, preparation, connection, options, adapter: new KubeadmClusterAdapter(options), facts: [facts('control'), facts('worker')] };
}

test('kubeadm plans actual declared order over discovered hosts and measured site evidence without effects', async () => {
  const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
  assert.equal(plan.disposition, 'create');
  assert.deepEqual(plan.actions.map(action => action.id), ['init-control', 'network-control', 'join-worker']);
  assert.equal(plan.preparations?.length, 2);
  assert.equal(plan.hostIdentities[0]!.identityDigest, identity('control'));
  assert.deepEqual(f.calls, []);
  assert.equal(readBootstrapPlan(plan).digest, plan.digest);
  assert.equal((await f.adapter.revalidate(plan, f.intent, f.facts, context())).valid, true);
});

test('bare hosts can plan pinned preparation, then require newly measured ready prerequisites before init', async () => {
  const f = fixture(); f.state.preparation = 'preparable';
  const bare = f.facts.map(fact => changeFacts(fact, value => { for (const tool of Object.values(value.tools)) { tool.status = 'absent'; delete tool.version; } }));
  const plan = await f.adapter.assess(f.intent, bare, context());
  assert.equal(plan.disposition, 'create');
  assert.deepEqual(plan.actions.map(action => action.phase), ['prepare', 'prepare', 'initialize', 'network', 'join']);
  const progress = { ...context(), completedActionIds: ['prepare-control', 'prepare-worker'] };
  assert.equal((await f.adapter.revalidate(plan, f.intent, bare, progress)).valid, false);
  f.state.preparation = 'ready';
  assert.equal((await f.adapter.revalidate(plan, f.intent, f.facts, progress)).valid, true);
  assert.deepEqual(f.calls, []);
});

test('unknown lookup, false site evidence, stale observations and insufficient real capacity stop before effects', async () => {
  for (const scenario of ['lookup', 'site', 'stale', 'ram', 'version'] as const) {
    const f = fixture();
    if (scenario === 'lookup') f.state.unknown = true;
    if (scenario === 'site') f.state.passed = false;
    if (scenario === 'stale') f.state.stale = true;
    if (scenario === 'ram') f.facts[0] = changeFacts(f.facts[0]!, value => { value.memory.totalBytes = 512 * 1024 ** 2; value.memory.availableBytes = 256 * 1024 ** 2; });
    if (scenario === 'version') f.facts[0] = changeFacts(f.facts[0]!, value => { value.tools.kubeadm!.version = '1.36.0'; });
    const plan = await f.adapter.assess(f.intent, f.facts, context());
    assert.equal(plan.disposition, 'blocked', scenario); assert.equal(plan.actions.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('execution is once in reviewed order, pins strict host context and binds the new physical cluster after init', async () => {
  const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
  await assert.rejects(f.adapter.executeAction(plan, 'init-control', context()), /Cluster bootstrap adapter failed/);
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  await assert.rejects(f.adapter.executeAction(plan, 'network-control', context()));
  const initialized = await f.adapter.executeAction(plan, 'init-control', context());
  assert.deepEqual(initialized.resource, f.resource);
  assert.deepEqual(Object.keys(f.calls[0]!.ctx).sort(), ['executionId', 'expectedIdentityDigest', 'operationId']);
  assert.equal(f.calls[0]!.ctx.expectedIdentityDigest, identity('control'));
  const next = { ...context(), completedActionIds: ['init-control'], resource: initialized.resource };
  assert.equal((await f.adapter.revalidate(plan, f.intent, f.facts, next)).valid, true);
  await f.adapter.executeAction(plan, 'network-control', next);
  const joined = { ...next, completedActionIds: ['init-control', 'network-control'] };
  await f.adapter.revalidate(plan, f.intent, f.facts, joined);
  await f.adapter.executeAction(plan, 'join-worker', joined);
  const done = { ...next, completedActionIds: plan.actions.map(action => action.id) };
  assert.equal((await f.adapter.verify(f.resource, 'kubernetes-access-new', done)).ok, true);
  await assert.rejects(f.adapter.executeAction(plan, 'init-control', done));
});

test('actual machine/cluster substitutions and raw command failures cannot become safe retry or new creation', async () => {
  const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
  const changed = f.facts.map(fact => changeFacts(fact, value => { value.identityDigest = identity('replacement'); }));
  assert.equal((await f.adapter.revalidate(plan, f.intent, changed, context())).valid, false);
  f.state.thrown = true;
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  await assert.rejects(f.adapter.executeAction(plan, 'init-control', context()), error => {
    assert.equal((error as any).effect, 'uncertain'); assert.equal(JSON.stringify(error).includes('private-token-never-record'), false);
    assert.equal((error as Error).message.includes('private-token-never-record'), false); return true;
  });
  await assert.rejects(f.adapter.revalidate(plan, f.intent, f.facts, context()));
});

test('failed or invalid revalidation revokes a previous permit before every effect', async () => {
  for (const scenario of ['capacity', 'invalid'] as const) {
    const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
    assert.equal((await f.adapter.revalidate(plan, f.intent, f.facts, context())).valid, true);
    if (scenario === 'capacity') {
      const changed = f.facts.map(fact => changeFacts(fact, value => { value.disk.availableBytes = 1; }));
      assert.equal((await f.adapter.revalidate(plan, f.intent, changed, context())).valid, false);
    } else await assert.rejects(f.adapter.revalidate(plan, f.intent, f.facts, { ...context(), unsupported: true } as any));
    await assert.rejects(f.adapter.executeAction(plan, 'init-control', context()));
    assert.equal(f.calls.length, 0);
  }
});

test('one successful preflight permits only one concurrent execution and cannot authorize a changed plan', async () => {
  const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  const changed = sealBootstrapPlan({ ...plan, actions: plan.actions.slice(1) });
  await assert.rejects(f.adapter.executeAction(changed, 'network-control', context()));
  const outcomes = await Promise.allSettled([f.adapter.executeAction(plan, 'init-control', context()), f.adapter.executeAction(plan, 'init-control', context())]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1);
});

test('an expired permit and a substituted created cluster require new inspection without further writes', async () => {
  const f = fixture(), plan = await f.adapter.assess(f.intent, f.facts, context());
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  const now = Date.now;
  try {
    Date.now = () => now() + 31000;
    await assert.rejects(f.adapter.executeAction(plan, 'init-control', context()));
  } finally { Date.now = now; }
  assert.equal(f.calls.length, 0);
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  const receipt = await f.adapter.executeAction(plan, 'init-control', context());
  f.resource.physicalId = 'replaced-kube-system-uid';
  const progress = { ...context(), completedActionIds: ['init-control'], resource: receipt.resource };
  const result = await f.adapter.revalidate(plan, f.intent, f.facts, progress);
  assert.equal(result.valid, false); assert.ok(result.reasons.includes('created-cluster-identity-changed'));
  await assert.rejects(f.adapter.executeAction(plan, 'network-control', progress));
  assert.equal(f.calls.length, 1);
});

test('changing caller strategy cannot omit required preparation under a recomputed plan digest', async () => {
  const f = fixture(); f.state.preparation = 'preparable';
  const plan = await f.adapter.assess(f.intent, f.facts, context());
  assert.equal(plan.disposition, 'create');
  const changed = sealBootstrapPlan({ ...plan, actions: plan.actions.filter(action => action.id !== 'prepare-worker') });
  await assert.rejects(f.adapter.revalidate(changed, f.intent, f.facts, context()));
  await assert.rejects(f.adapter.executeAction(changed, 'prepare-control', context()));
  assert.equal(f.calls.length, 0);
});

test('only API health never claims cluster verification or CNI completion', async () => {
  const f = fixture(); f.state.initialized = true;
  assert.equal((await f.adapter.verify(f.resource, 'cluster-profile', context())).ok, false);
});

test('existing cluster strategy stays read-only and cannot silently create a missing cluster', async () => {
  const f = fixture(); f.state.initialized = true;
  const intent: BootstrapIntent = { ...f.intent, mode: 'existing', topology: { ...f.intent.topology, nodes: [] } };
  const adapter = new ExistingClusterAdapter({ id: 'existing', scope: f.resource.scope, intent, connection: f.connection });
  const plan = await adapter.assess(intent, [], context());
  assert.equal(plan.disposition, 'connect'); assert.equal(plan.actions.length, 0); assert.deepEqual(plan.existingResource, f.resource);
  assert.equal((await adapter.revalidate(plan, intent, [], context())).valid, true);
  f.state.initialized = false;
  assert.equal((await adapter.assess(intent, [], context())).disposition, 'blocked');
  await assert.rejects(adapter.executeAction(plan, 'make-a-cluster', context()));
  assert.deepEqual(f.calls, []);
});

test('existing target must report a measured supported API version, not echo desired intent', async () => {
  for (const platformVersion of [undefined, '1.36.0', 'v1.37.0+k3s1']) {
    const f = fixture(); f.state.initialized = true;
    const intent: BootstrapIntent = { ...f.intent, mode: 'existing', topology: { ...f.intent.topology, nodes: [] } };
    const connection = { ...f.connection, inspect: async () => ({ status: 'present' as const, resource: f.resource, ...(platformVersion ? { platformVersion } : {}) }) };
    const adapter = new ExistingClusterAdapter({ id: 'existing', scope: f.resource.scope, intent, connection });
    const plan = await adapter.assess(intent, [], context());
    assert.equal(plan.disposition, 'blocked'); assert.ok(plan.reasons.some(reason => reason.startsWith('existing-platform-version')));
    assert.equal((await adapter.verify(f.resource, 'cluster-access', context())).ok, false); assert.equal(f.calls.length, 0);
  }
});

test('generic existing-cluster contracts preserve and compare exact provider versions without changing core', async () => {
  for (const requested of ['1.37.0+k3s1', '2.0.0-rc.1+provider.2', '0.9.0']) {
    const f = fixture(); f.state.initialized = true; f.state.network = true; f.state.joined = true;
    const intent = readBootstrapIntent({ ...f.intent, mode: 'existing', topology: { version: `v${requested}`, nodes: [] } });
    const connection = { ...f.connection, inspect: async () => ({ status: 'present' as const, resource: f.resource, platformVersion: `v${requested}` }) };
    const adapter = new ExistingClusterAdapter({ id: 'existing-provider', scope: f.resource.scope, intent, connection });
    assert.equal(intent.topology.version, requested);
    assert.equal((await adapter.assess(intent, [], context())).disposition, 'connect');
    assert.equal((await adapter.verify(f.resource, 'cluster-access', context())).ok, true);
    assert.equal(f.calls.length, 0);
  }
  for (const invalid of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3+', '1.2.3-a..b', 'latest']) {
    assert.throws(() => readBootstrapIntent({ id: 'cluster', mode: 'existing', topology: { version: invalid, nodes: [] } }));
  }
});

test('kubeadm-specific planning blocks non-upstream versions and missing tools while generic contracts remain open', async () => {
  const f = fixture();
  const intent = readBootstrapIntent({ ...f.intent, topology: { ...f.intent.topology, version: '1.37.0+vendor.1' } });
  const adapter = new KubeadmClusterAdapter({ ...f.options, intent });
  const plan = await adapter.assess(intent, f.facts, context());
  assert.equal(plan.disposition, 'blocked'); assert.ok(plan.reasons.includes('kubeadm-upstream-stable-version-required'));
  const unknownTools = f.facts.map(fact => changeFacts(fact, value => { value.tools = { siteAgent: { status: 'installed', version: 'agent-2026.11' } }; }));
  const missing = await f.adapter.assess(f.intent, unknownTools, context());
  assert.equal(missing.disposition, 'blocked'); assert.ok(missing.reasons.includes('host-kubernetes-version-mismatch'));
  assert.equal(f.calls.length, 0);
});

test('new read-only observation receipts do not change the existing cluster operation identity', async () => {
  const f = fixture(); let read = 0;
  const intent: BootstrapIntent = { ...f.intent, mode: 'existing', topology: { ...f.intent.topology, nodes: [] } };
  const connection = { ...f.connection, inspect: async () => ({ status: 'present' as const, platformVersion: 'v1.37.0',
    resource: { ...f.resource, receipt: { id: `observation-${++read}` } } }) };
  const adapter = new ExistingClusterAdapter({ id: 'existing', scope: f.resource.scope, intent, connection });
  const plan = await adapter.assess(intent, [], context()), revalidated = await adapter.revalidate(plan, intent, [], context());
  assert.equal(revalidated.valid, true); assert.equal(plan.existingResource?.receipt, undefined);
  assert.notEqual(plan.observationsDigest, revalidated.observationsDigest); assert.equal(f.calls.length, 0);
});

test('custom policy cannot bypass an unavailable capability or replace the registered action set', async () => {
  const f = fixture(), baseline = conservativeClusterBootstrapStrategy();
  const input = { adapterId: 'adapter', scope: 'scope', configurationDigest: fingerprint('configuration'), intent: f.intent, facts: f.facts,
    observation: { status: 'absent' as const }, capabilities: { supported: false, reasons: ['unsupported'] }, actions: [] };
  const bad = { id: 'custom', digest: fingerprint('custom-policy'), assess(value: typeof input) {
    const result = baseline.assess(value); return sealBootstrapPlan({ ...result, disposition: 'create', reasons: [], strategy: { id: this.id, digest: this.digest } });
  } };
  assert.throws(() => assessBootstrapStrategy(bad, input));
});

test('host registration captures methods and policy identity before later caller property replacement', async () => {
  const f = fixture();
  f.options.connection.inspect = async () => { throw new Error('replaced-private-token'); };
  f.options.hosts[0]!.transport.run = async () => { throw new Error('replaced-private-token'); };
  f.preparation.inspect = async () => { throw new Error('replaced-private-token'); };
  const plan = await f.adapter.assess(f.intent, f.facts, context());
  assert.equal(plan.disposition, 'create');
  await f.adapter.revalidate(plan, f.intent, f.facts, context());
  const receipt = await f.adapter.executeAction(plan, 'init-control', context());
  assert.equal(receipt.status, 'completed');
});

test('fixed kubeadm action privately verifies exact config bytes and safely quotes paths before the actual command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kubeadm-script-'));
  try {
    const config = join(directory, "config ' pinned.yaml"), binary = join(directory, 'fake-kubeadm'), output = join(directory, 'arguments');
    await writeFile(config, 'private-config-and-token');
    await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${output}'\nprintf '%s\\n' 'never-record-command-output'\n`, { mode: 0o700 });
    const action = createKubeadmHostAction({ id: 'fixed-init', phase: 'initialize', binary, configurationFile: config,
      configurationSha256: createHash('sha256').update('private-config-and-token').digest('hex') });
    assert.equal(action.effect, 'mutating'); assert.match(action.script, /--skip-token-print/); assert.doesNotMatch(action.script, /curl|--ignore-preflight|reset/);
    const result = await promisify(execFile)('/bin/sh', ['-c', action.script]);
    assert.equal(result.stdout.trim(), KUBEADM_ACTION_COMPLETE); assert.equal(result.stdout.includes('never-record-command-output'), false);
    const args = await readFile(output, 'utf8'); assert.match(args, /^init\n--config\n/); assert.match(args, /--skip-token-print/);
    await writeFile(config, 'changed'); await rm(output);
    await assert.rejects(promisify(execFile)('/bin/sh', ['-c', action.script]));
    await assert.rejects(readFile(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
