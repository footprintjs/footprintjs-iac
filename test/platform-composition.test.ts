import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FixedHostDiscovery, HOST_INVENTORY_ACTION, LocalHostAccessTransport } from '../src/platform-access/index.ts';
import { KubeadmClusterAdapter } from '../src/platform-bootstrap/kubeadm.ts';
import { createKubeadmHostAction, KUBEADM_ACTION_COMPLETE } from '../src/platform-bootstrap/kubeadm-actions.ts';
import { CLUSTER_VERIFICATION_CHECKS } from '../src/platform-bootstrap/connection.ts';
import type { BootstrapContext, BootstrapIntent, HostPreparationPort } from '../src/platform-bootstrap/types.ts';
import { PlatformClusterWorkflow } from '../src/platform-workflow/index.ts';
import { fingerprint } from '../src/util.ts';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-composition-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function composition(directory: string) {
  const host = { id: 'server-a', profileId: 'ssh-management-a', scope: 'registered-server-a' };
  const scope = 'cluster-registration-a', machine = fingerprint('controlled-machine-a');
  const resource = { id: 'cluster-a', kind: 'kubernetes-cluster', physicalId: 'actual-api-identity-a', scope };
  const intent: BootstrapIntent = { id: resource.id, mode: 'create', topology: { version: '1.35.0',
    nodes: [{ hostId: host.id, role: 'control-plane' }], podNetworkCidr: '10.244.0.0/16', serviceNetworkCidr: '10.96.0.0/12' } };
  const control = { present: false, ready: true, fail: false, automaticProfile: true, catalogFail: false,
    inventoryCalls: 0, actionCalls: [] as string[], connects: 0 };
  const initialize = createKubeadmHostAction({ id: 'initialize-a', phase: 'initialize', binary: '/usr/bin/kubeadm',
    configurationFile: '/etc/footprint/initialize.yaml', configurationSha256: fingerprint('reviewed-init-config') });
  const network = createKubeadmHostAction({ id: 'network-a', phase: 'network', binary: '/usr/bin/kubectl', kubeconfigFile: '/etc/kubernetes/admin.conf',
    configurationFile: '/etc/footprint/network.yaml', configurationSha256: fingerprint('reviewed-network-config') });
  const transport = new LocalHostAccessTransport({ host, actions: [HOST_INVENTORY_ACTION, initialize, network], allowMutations: true,
    runner: async request => {
      if (request.input === HOST_INVENTORY_ACTION.script) {
        control.inventoryCalls++;
        const values = { family: 'linux', distribution: 'debian', os_version: '12', kernel: '6.12.1', architecture: 'amd64', identity: machine,
          cpu: '4', memory_total: String(8 * 1024 ** 3), memory_available: String(6 * 1024 ** 3), disk_total: String(100 * 1024 ** 3),
          disk_available: String(80 * 1024 ** 3), privilege: 'root', kubernetes: control.present ? 'present' : 'unknown',
          kubeadm: 'installed', 'kubeadm-version': 'v1.35.0', kubelet: 'installed', 'kubelet-version': 'v1.35.0',
          kubectl: 'installed', 'kubectl-version': 'v1.35.0', containerd: 'installed', 'containerd-version': 'v2.1.0' };
        return { code: 0, stdout: 'footprint-host-inventory-v1\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n' };
      }
      // The actual strict transport admits minimal access context and prepends the physical-host fence.
      assert.ok(request.input.includes(`if [ "$identity" != '${machine}' ]`));
      const action = request.input.includes('/etc/footprint/initialize.yaml') ? initialize : request.input.includes('/etc/footprint/network.yaml') ? network : undefined;
      assert.ok(action, 'only host-registered immutable installer actions reach the runner');
      control.actionCalls.push(action.id);
      if (control.fail) throw Error('private-remote-stderr-and-token');
      if (action === initialize) control.present = true;
      return { code: 0, stdout: KUBEADM_ACTION_COMPLETE + '\n' };
    } });
  const preparation: HostPreparationPort = {
    id: 'site-preparation', recipeDigest: fingerprint('site-preparation-recipe'),
    async inspect(facts) {
      const value = { hostId: host.id, identityDigest: facts.identityDigest!, recipeDigest: this.recipeDigest,
        status: control.ready ? 'ready' as const : 'unknown' as const, actions: [], observedAt: Date.now(),
        checks: ['node-cleanliness', 'network', 'configuration', 'cni-artifacts', 'packages', 'runtime'].map(id => ({ id, passed: control.ready })) };
      return { ...value, digest: fingerprint(value) };
    },
  };
  const lifecycle = new KubeadmClusterAdapter({ id: 'kubeadm-site-a', scope, intent, networkActionId: network.id,
    hosts: [{ hostId: host.id, transport, preparation, initializeActionId: initialize.id }],
    connection: {
      async inspect(_context: BootstrapContext) { return control.present ? { status: 'present', resource, platformVersion: intent.topology.version } : { status: 'absent' }; },
      async publishAccess() { return control.automaticProfile ? { profileId: 'kubernetes-access-a' } : undefined; },
      async verify() { return { ok: true, checks: CLUSTER_VERIFICATION_CHECKS.map(id => ({ id, passed: true })) }; },
    } });
  const workflow = new PlatformClusterWorkflow({
    definition: { id: 'site-platform-a', label: 'Site platform', resourceId: resource.id, mode: 'create', target: { id: 'site-a', scope }, configurationDigest: fingerprint('site-a-configuration') },
    hosts: [host], intent, directory, lifecycle, discovery: new FixedHostDiscovery({ transport }),
    profileCatalogId: 'site-kubernetes-profiles',
    profiles: async () => {
      if (control.catalogFail) throw Error('private-profile-broker-credential-body');
      return [{ id: 'kubernetes-access-a', label: 'Verified cluster access' }];
    },
    async resolveDetails(actual, profileId) { return { profileId, resourceId: actual.id, endpoint: 'https://cluster.example.test:6443', protocol: 'kubernetes', credentialRef: 'opaque-kubernetes-credential' }; },
    async connect() { control.connects++; return { id: 'connected-kubernetes-access' }; },
  });
  return { control, workflow };
}

test('real discovery, strict access transport and concrete kubeadm lifecycle compose through native platform flow', () => fixture(async directory => {
  const { workflow, control } = composition(directory);
  const result = await workflow.start();
  assert.equal(result.status, 'passed');
  assert.deepEqual(control.actionCalls, ['initialize-a', 'network-a']);
  assert.ok(control.inventoryCalls >= 4, 'actual fixed discovery is called before assessment, actions and connection');
  assert.equal(control.connects, 1);
  assert.equal(result.bootstrap.accessProfileId, 'kubernetes-access-a');
  assert.equal(result.connection?.status, 'passed');
  assert.equal((await workflow.snapshot()).status, 'passed');
  assert.deepEqual(control.actionCalls, ['initialize-a', 'network-a'], 'native evidence replay sends no installer action');
}));

test('unknown site preparation through concrete composition records a blocked assessment and sends no installer or connection effect', () => fixture(async directory => {
  const { workflow, control } = composition(directory); control.ready = false;
  const result = await workflow.start();
  assert.equal(result.status, 'blocked');
  assert.equal(control.inventoryCalls, 1);
  assert.deepEqual(control.actionCalls, []); assert.equal(control.connects, 0);
  assert.ok(result.bootstrap.recordings.every(record => record.complete));
}));

test('concrete transport failure remains uncertain and its private process body never reaches native files', () => fixture(async directory => {
  const { workflow, control } = composition(directory); control.fail = true;
  const result = await workflow.start();
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(control.actionCalls, ['initialize-a']); assert.equal(control.connects, 0);
  await assert.rejects(workflow.start(), /already started/);
  for (const file of await readdir(join(directory, 'bootstrap'))) if (file.endsWith('.json') || file.endsWith('.jsonl')) {
    assert.equal((await readFile(join(directory, 'bootstrap', file), 'utf8')).includes('private-remote-stderr-and-token'), false);
  }
}));

test('a failing profile broker after installation is retained safely without echoing credentials or repeating actions', () => fixture(async directory => {
  const { workflow, control } = composition(directory); control.automaticProfile = false; control.catalogFail = true;
  const result = await workflow.start();
  assert.notEqual(result.status, 'passed');
  assert.equal(JSON.stringify(result).includes('private-profile-broker-credential-body'), false);
  assert.deepEqual(control.actionCalls, ['initialize-a', 'network-a']); assert.equal(control.connects, 0);
  assert.equal((await workflow.snapshot()).bootstrap.actions.every(action => action.status === 'completed'), true);
  for (const file of await readdir(join(directory, 'bootstrap'))) if (file.endsWith('.json') || file.endsWith('.jsonl')) {
    assert.equal((await readFile(join(directory, 'bootstrap', file), 'utf8')).includes('private-profile-broker-credential-body'), false);
  }
}));
