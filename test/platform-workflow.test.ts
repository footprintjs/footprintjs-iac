import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostFactsDigest } from '../src/platform-access/facts.ts';
import { FixedHostDiscovery } from '../src/platform-access/discovery.ts';
import { HOST_INVENTORY_ACTION } from '../src/platform-access/inventory-action.ts';
import { LocalHostAccessTransport } from '../src/platform-access/local.ts';
import type { HostFactsSnapshot, HostRef } from '../src/platform-access/types.ts';
import { sealBootstrapPlan } from '../src/platform-bootstrap/data.ts';
import type { BootstrapIntent, ClusterLifecycleAdapter } from '../src/platform-bootstrap/types.ts';
import { createHostAccessWorkflow, PlatformClusterWorkflow } from '../src/platform-workflow/index.ts';
import type { PlatformWorkflowOptions } from '../src/platform-workflow/types.ts';
import { FileResourceFlowStore } from '../src/resource-flow/store.ts';
import type { ConnectionProfileChoice, ResourceHandle } from '../src/resource-flow/types.ts';
import { fingerprint } from '../src/util.ts';
import { loadEvidence, backwalk, replay } from '../src/evidence.ts';
import { sliceToJSON } from 'foottrace';

function fixture(directory: string, mode: BootstrapIntent['mode'] = 'create') {
  const host: HostRef = { id: 'host-a', scope: 'registered-office-host', profileId: 'ssh-management-a' };
  const intent: BootstrapIntent = { id: 'office-cluster', mode, topology: { version: '1.35.0', nodes: [{ hostId: host.id, role: 'control-plane' }] } };
  const choices: ConnectionProfileChoice[] = [];
  const resource: ResourceHandle = { id: intent.id, kind: 'kubernetes-cluster', physicalId: 'cluster-physical-a', scope: 'registered-cluster' };
  const control = { calls: [] as string[], present: mode === 'existing', automatic: true, invalid: false, blocked: false,
    throwAction: undefined as string | undefined, changedHost: false, now: Date.now(), connected: 0, published: 0 };
  const facts = (): HostFactsSnapshot => {
    const value: Omit<HostFactsSnapshot, 'digest'> = { version: 1, kind: 'host-facts', host, observedAt: ++control.now, status: 'complete', identityDigest: fingerprint(control.changedHost ? 'other-machine' : 'original-machine'),
      os: { family: 'linux', distribution: 'ubuntu', version: '24.04', kernel: '6.8.0' }, architecture: 'amd64', cpuCount: 4,
      memory: { totalBytes: 8_000_000_000, availableBytes: 6_000_000_000 }, disk: { path: '/', totalBytes: 100_000_000_000, availableBytes: 50_000_000_000 },
      privilege: 'root', tools: { kubeadm: { status: 'installed', version: '1.35.0' }, kubelet: { status: 'installed', version: '1.35.0' }, kubectl: { status: 'installed', version: '1.35.0' }, containerd: { status: 'installed', version: '2.1.0' } },
      kubernetes: { status: control.present ? 'present' : 'absent' } };
    return { ...value, digest: hostFactsDigest(value) };
  };
  const lifecycle: ClusterLifecycleAdapter = {
    id: 'controlled-kubernetes', scope: resource.scope,
    async assess(input, observed) {
      return sealBootstrapPlan({ kind: 'cluster-bootstrap-plan', version: 1, adapterId: this.id, scope: this.scope, mode,
        intentDigest: fingerprint(input), configurationDigest: fingerprint('controlled-actions'), strategy: { id: 'controlled-conservative', digest: fingerprint('strategy') },
        hostIdentities: observed.map(value => ({ hostId: value.host.id, identityDigest: value.identityDigest! })), observationsDigest: fingerprint(observed),
        disposition: control.blocked ? 'blocked' : mode === 'create' ? 'create' : 'connect', reasons: control.blocked ? ['host-capability-unknown'] : [],
        actions: control.blocked || mode === 'existing' ? [] : [{ id: 'initialize', hostId: host.id, phase: 'initialize', actionDigest: fingerprint('initialize') }, { id: 'network', hostId: host.id, phase: 'network', actionDigest: fingerprint('network') }] });
    },
    async revalidate(plan, _intent, observed, context) {
      control.calls.push('validate:' + context.completedActionIds.join(','));
      return { valid: !control.invalid && observed.every(value => plan.hostIdentities.some(identity => identity.hostId === value.host.id && identity.identityDigest === value.identityDigest)),
        planDigest: plan.digest, observationsDigest: fingerprint(observed), reasons: control.invalid ? ['capability-changed'] : [] };
    },
    async executeAction(_plan, actionId, context) {
      const saved = JSON.parse(await readFile(join(directory, 'bootstrap/platform-bootstrap.json'), 'utf8'));
      assert.equal(saved.state.actions.find((action: {id:string}) => action.id === actionId).status, 'started', 'intent is durable before this actual action');
      assert.ok(context.operationId); control.calls.push('execute:' + actionId);
      if (actionId === 'initialize') control.present = true;
      if (control.throwAction === actionId) throw Error('private-kube-token-never-record');
      return { id: 'receipt-' + actionId, actionId, hostId: host.id, status: 'completed', receipt: { id: 'effect-' + actionId }, ...(actionId === 'initialize' ? { resource } : {}) };
    },
    async find() { return control.present ? { status: 'present', resource } : { status: 'absent' }; },
    async publishAccess() {
      control.published++;
      if (!control.automatic) return;
      if (!choices.length) choices.push({ id: 'kubernetes-access-a', label: 'Office cluster access' });
      return { profileId: choices[0]!.id };
    },
    async verify(actual, profileId) {
      assert.equal(actual.physicalId, resource.physicalId); assert.notEqual(profileId, host.profileId);
      return { ok: true, checks: [{ id: 'verified-cluster-access', passed: true }] };
    },
  };
  const options: PlatformWorkflowOptions = {
    definition: { id: 'office-platform', resourceId: intent.id, label: 'Office Kubernetes', mode, target: { id: 'office-target', scope: resource.scope }, configurationDigest: fingerprint('office-platform-config') },
    intent, hosts: [host], discovery: { id: 'controlled-host-discovery', async inspect() { return facts(); } }, lifecycle, directory,
    profiles: async () => choices, profileCatalogId: 'immutable-cluster-profiles',
    async resolveDetails(actual, profileId) { return { profileId, resourceId: actual.id, endpoint: 'https://kubernetes.example.test:6443', protocol: 'kubernetes', credentialRef: 'private-cluster-credential-ref' }; },
    async connect(_resource, _details, context) { control.connected++; return { id: 'connect-' + context.executionId }; },
  };
  return { options, control, lifecycle, choices, host, resource, facts };
}

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-flow-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('recorded Create validates before every effect, retains per-action intent, publishes a distinct profile and connects through ResourceFlow', () => withDirectory(async directory => {
  const f = fixture(directory), workflow = new PlatformClusterWorkflow(f.options);
  const state = await workflow.start();
  assert.equal(state.status, 'passed'); assert.equal(state.connection?.status, 'passed');
  assert.deepEqual(f.control.calls.filter(value => value.startsWith('execute:')), ['execute:initialize', 'execute:network']);
  assert.deepEqual(state.bootstrap.actions.map(value => value.status), ['completed', 'completed']);
  assert.equal(state.bootstrap.resource?.physicalId, f.resource.physicalId);
  assert.equal(state.bootstrap.accessProfileId, 'kubernetes-access-a'); assert.equal(f.control.connected, 1);
  const reopened = await new PlatformClusterWorkflow(f.options).snapshot();
  assert.equal(reopened.status, 'passed'); assert.equal(f.control.connected, 1, 'native replay is read-only');
  assert.equal(state.bootstrap.recordings.length, 2); assert.ok(state.bootstrap.recordings.every(record => record.complete));
  const evidence = JSON.parse(await readFile(state.bootstrap.recordings[1]!.evidencePath, 'utf8'));
  const names = JSON.stringify(evidence.structure);
  for (const name of ['Revalidate initialize', 'Retain intent initialize', 'Execute initialize', 'Revalidate network', 'Execute network']) assert.ok(names.includes(name));
  const beforeReplay = f.control.calls.length;
  const assessment = await loadEvidence(state.bootstrap.recordings[0]!.evidencePath), execution = await loadEvidence(state.bootstrap.recordings[1]!.evidencePath);
  assert.equal(assessment.stack, f.options.definition.id); assert.deepEqual(replay(assessment).state, assessment.snapshot.sharedState);
  const planWalk = sliceToJSON(backwalk(assessment, 'plan').slice);
  assert.ok(Object.keys(planWalk.nodes!).some(id => id.startsWith('discover#')), 'plan backwalk reaches the measured-facts writer');
  const actionWalk = sliceToJSON(backwalk(execution, 'receipt:initialize').slice), ids = Object.keys(actionWalk.nodes!);
  for (const prefix of ['execute-initialize#', 'intent-initialize#', 'revalidate-initialize#', 'refresh-initialize#', 'bind#']) assert.ok(ids.some(id => id.startsWith(prefix)), prefix);
  assert.equal(f.control.calls.length, beforeReplay, 'replay and causal backwalk invoke no discovery or execution adapters');
}));

test('Find mode measures an existing cluster without any installation or topology invention', () => withDirectory(async directory => {
  const f = fixture(directory, 'existing');
  const result = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(result.status, 'passed'); assert.equal(result.bootstrap.plan?.disposition, 'connect');
  assert.equal(result.bootstrap.actions.length, 0); assert.ok(f.control.calls.every(value => !value.startsWith('execute:')));
}));

test('missing generated access pauses natively; a new immutable Kubernetes profile resumes without repeating discovery assessment or installation', () => withDirectory(async directory => {
  const f = fixture(directory); f.control.automatic = false;
  const first = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(first.status, 'paused'); assert.equal(first.bootstrap.pause?.profiles.length, 0);
  assert.equal(first.bootstrap.recordings.at(-1)?.status, 'paused');
  const executions = f.control.calls.filter(value => value.startsWith('execute:')).length;
  f.choices.push({ id: 'operator-kubernetes-access', label: 'Operator supplied cluster access' });
  const second = await new PlatformClusterWorkflow(f.options).resume({ pauseToken: first.bootstrap.pause!.token, profileId: f.choices[0]!.id });
  assert.equal(second.status, 'passed'); assert.equal(f.control.published, 1); assert.equal(f.control.connected, 1);
  assert.equal(f.control.calls.filter(value => value.startsWith('execute:')).length, executions);
  assert.equal(second.bootstrap.recordings[2]?.resumedFromRunId, first.bootstrap.recordings[1]?.runId);
}));

test('blocked facts and changed live identity stop before mutation and before application connection', () => withDirectory(async directory => {
  const f = fixture(directory); f.control.blocked = true;
  const blocked = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(blocked.status, 'blocked'); assert.equal(f.control.connected, 0);
  assert.ok(f.control.calls.every(value => !value.startsWith('execute:')));
  const secondDir = join(directory, 'changed'), g = fixture(secondDir); g.control.invalid = true;
  const changed = await new PlatformClusterWorkflow(g.options).start();
  assert.equal(changed.status, 'failed'); assert.ok(g.control.calls.every(value => !value.startsWith('execute:')));
}));

test('an uncertain command retains the exact action and blocks retries across reopen without leaking the private provider error', () => withDirectory(async directory => {
  const f = fixture(directory); f.control.throwAction = 'initialize';
  const result = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(result.status, 'incomplete'); assert.equal(result.bootstrap.actions[0]?.status, 'uncertain');
  assert.equal(result.bootstrap.actions[1]?.status, 'pending'); assert.equal(f.control.connected, 0);
  await assert.rejects(() => new PlatformClusterWorkflow(f.options).start(), /already started/);
  assert.deepEqual(f.control.calls.filter(value => value.startsWith('execute:')), ['execute:initialize']);
  for (const filename of await readdir(join(directory, 'bootstrap'))) if (filename.endsWith('.json') || filename.endsWith('.jsonl')) {
    assert.equal((await readFile(join(directory, 'bootstrap', filename), 'utf8')).includes('private-kube-token-never-record'), false);
  }
}));

test('pause answers cannot replace management access, replay a consumed token or substitute the actual cluster', () => withDirectory(async directory => {
  const f = fixture(directory); f.control.automatic = false;
  const workflow = new PlatformClusterWorkflow(f.options), paused = await workflow.start();
  f.choices.push({ id: f.host.profileId, label: 'Management profile is not Kubernetes access' });
  await assert.rejects(() => workflow.resume({ pauseToken: paused.bootstrap.pause!.token, profileId: f.host.profileId }), /stale/);
  f.choices.splice(0, 1, { id: 'cluster-manual', label: 'Manual cluster access' });
  const answer = { pauseToken: paused.bootstrap.pause!.token, profileId: 'cluster-manual' };
  const completed = await workflow.resume(answer); assert.equal(completed.status, 'passed');
  await assert.rejects(() => workflow.resume(answer), /stale/);
}));

test('a forged completed journal cannot override the native acquisition evidence', () => withDirectory(async directory => {
  const f = fixture(directory); const completed = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(completed.status, 'passed');
  const path = join(directory, 'bootstrap/platform-bootstrap.json'), value = JSON.parse(await readFile(path, 'utf8'));
  value.state.actions[0].receipt.receipt.id = 'substituted-effect-receipt';
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(() => new PlatformClusterWorkflow(f.options).snapshot(), /native evidence/);
}));

test('host access uses a separate existing-resource native pause and never provisions or changes its selected management profile', () => withDirectory(async directory => {
  let selected = false, connects = 0;
  const options = {
    definition: { id: 'host-access', resourceId: 'server-a', label: 'Server management access', mode: 'existing' as const, target: { id: 'host-target', scope: 'registered-server' }, configurationDigest: fingerprint('server-access-config') },
    store: new FileResourceFlowStore(directory), profiles: [{ id: 'ssh-management-a', label: 'SSH management' }],
    adapters: {
      async find() { return { id: 'server-a', kind: 'server', physicalId: 'registered-endpoint-a', scope: 'registered-server' }; },
      async resolveDetails(_resource: ResourceHandle, profileId?: string) { return !selected && !profileId ? undefined : { profileId: 'ssh-management-a', resourceId: 'server-a', endpoint: 'ssh://server.example.test:22', protocol: 'ssh', credentialRef: 'host-key-ref' }; },
      async validate() {}, async connect() { selected = true; connects++; return { id: 'authenticated-host-access' }; },
      async verify() { return { ok: true, checks: [{ id: 'authenticated-management-channel', passed: true }] }; },
    },
  };
  const workflow = createHostAccessWorkflow(options), paused = await workflow.start();
  assert.equal(paused.status, 'paused'); assert.equal(connects, 0);
  const complete = await workflow.resume({ pauseToken: paused.pause!.token, profileId: 'ssh-management-a' });
  assert.equal(complete.status, 'passed'); assert.equal(complete.details?.profileId, 'ssh-management-a'); assert.equal(connects, 1);
}));

test('a host retarget after one successful action stops the next action while retaining the physical acquisition', () => withDirectory(async directory => {
  const f = fixture(directory), execute = f.lifecycle.executeAction.bind(f.lifecycle);
  f.lifecycle.executeAction = async (...args) => {
    const receipt = await execute(...args); f.control.changedHost = true; return receipt;
  };
  const state = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(state.status, 'failed'); assert.equal(state.bootstrap.actions[0]?.status, 'completed');
  assert.equal(state.bootstrap.actions[1]?.status, 'pending'); assert.equal(state.bootstrap.resource?.physicalId, 'cluster-physical-a');
  assert.deepEqual(f.control.calls.filter(value => value.startsWith('execute:')), ['execute:initialize']); assert.equal(f.control.connected, 0);
}));

test('a substituted physical cluster during a human wait cannot connect and never repeats installation', () => withDirectory(async directory => {
  const f = fixture(directory); f.control.automatic = false;
  const workflow = new PlatformClusterWorkflow(f.options), paused = await workflow.start();
  f.resource.physicalId = 'foreign-cluster';
  f.choices.push({ id: 'operator-kubernetes-access', label: 'Operator supplied cluster access' });
  const state = await workflow.resume({ pauseToken: paused.bootstrap.pause!.token, profileId: f.choices[0]!.id });
  assert.equal(state.status, 'failed'); assert.equal(f.control.connected, 0);
  assert.deepEqual(f.control.calls.filter(value => value.startsWith('execute:')), ['execute:initialize', 'execute:network']);
}));

test('workflow captures registered adapter methods before asynchronous work and never invokes later replacements', () => withDirectory(async directory => {
  const f = fixture(directory), workflow = new PlatformClusterWorkflow(f.options);
  f.options.discovery!.inspect = async () => { throw Error('replacement-discovery'); };
  f.lifecycle.executeAction = async () => { throw Error('replacement-installer'); };
  f.options.resolveDetails = async () => { throw Error('replacement-resolver'); };
  f.options.connect = async () => { throw Error('replacement-connect'); };
  assert.equal((await workflow.start()).status, 'passed'); assert.equal(f.control.connected, 1);
}));

test('freshness and required measured facts remain mandatory even for a custom lifecycle that would approve them', () => withDirectory(async directory => {
  for (const [name, observedAt, emptyMemory] of [['stale', Date.now() - 60_000, false], ['future', Date.now() + 60_000, false], ['unknown', Date.now(), true]] as const) {
    const f = fixture(join(directory, name));
    let assessments = 0; const assess = f.lifecycle.assess.bind(f.lifecycle);
    f.lifecycle.assess = async (...args) => { assessments++; return assess(...args); };
    f.options.discovery!.inspect = async () => {
      const { digest: _digest, ...base } = f.facts(); base.observedAt = observedAt;
      if (emptyMemory) { base.memory.availableBytes = null; base.status = 'partial'; }
      return { ...base, digest: hostFactsDigest(base) };
    };
    const state = await new PlatformClusterWorkflow(f.options).start();
    assert.equal(state.status, 'failed'); assert.equal(f.control.connected, 0); assert.ok(f.control.calls.every(value => !value.startsWith('execute:')));
    if (emptyMemory) assert.equal(assessments, 1, 'common admission rejects unknown memory after the custom strategy approves');
  }
}));

test('an existing managed cluster requires no invented host inventory or SSH discovery port', () => withDirectory(async directory => {
  const f = fixture(directory, 'existing'); f.options.intent.topology.nodes = []; f.options.hosts = []; delete f.options.discovery;
  const state = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(state.status, 'passed'); assert.deepEqual(state.bootstrap.facts, []); assert.equal(state.bootstrap.actions.length, 0);
}));

test('the concrete fixed discovery and strict local access transport compose through the workflow context boundary', () => withDirectory(async directory => {
  const f = fixture(directory, 'existing'), toolNames = ['kubeadm', 'kubelet', 'kubectl', 'containerd']; let inventoryCalls = 0;
  const output = ['footprint-host-inventory-v1', 'family=linux', 'distribution=ubuntu', 'os_version=24.04', 'kernel=6.8.0', 'architecture=amd64',
    'identity=' + fingerprint('strict-inventory-host'), 'cpu=4', 'memory_total=8000000000', 'memory_available=6000000000', 'disk_total=100000000000',
    'disk_available=50000000000', 'privilege=root', 'kubernetes=present', ...toolNames.flatMap(name => [name + '=installed', name + '-version=' + (name === 'containerd' ? '2.1.0' : '1.35.0')])].join('\n') + '\n';
  const transport = new LocalHostAccessTransport({ host: f.host, actions: [HOST_INVENTORY_ACTION], runner: async request => {
    inventoryCalls++; assert.equal(request.file, '/bin/sh'); assert.equal(request.args[0], '-s'); return { code: 0, stdout: output };
  } });
  f.options.discovery = new FixedHostDiscovery({ transport });
  const state = await new PlatformClusterWorkflow(f.options).start();
  assert.equal(state.status, 'passed'); assert.equal(state.bootstrap.facts![0]!.status, 'complete'); assert.ok(inventoryCalls >= 1);
}));
