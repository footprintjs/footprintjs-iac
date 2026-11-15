import assert from 'node:assert/strict';
import {
  FixedHostDiscovery, HOST_INVENTORY_ACTION, HOST_PREPARATION_CHECKS, KUBEADM_ACTION_COMPLETE,
  KubeadmClusterAdapter, LocalHostAccessTransport, PinnedRecipeHostPreparation, createKubeadmHostAction,
  type BootstrapIntent,
} from '../../src/platform/index.ts';
import { fixtureConnection, fixtureHost, fixtureScope } from './connection.ts';
import { FIXTURE_IDENTITY, fixtureDigest, fixtureInventory, type FixtureControl } from './inventory.ts';

/** Concrete adapters with a controlled process boundary: no shell program or network request runs. */
export function createPlatformFixture() {
  const control: FixtureControl = { prepared: false, present: false, networkReady: false, version: '1.35.0', inventoryCalls: 0, inspections: 0, connects: 0, actions: [] };
  const intent: BootstrapIntent = { id: 'fixture-cluster-a', mode: 'create', topology: { version: control.version,
    nodes: [{ hostId: fixtureHost.id, role: 'control-plane' }], podNetworkCidr: '10.244.0.0/16', serviceNetworkCidr: '10.96.0.0/12' } };
  const preparation = new PinnedRecipeHostPreparation({ id: 'fixture-pinned-preparation',
    recipes: [{ hostId: fixtureHost.id, id: 'prepare-fixture-host', recipePath: '/etc/footprint/fixture-preparation.sh', recipeSha256: fixtureDigest('controlled-reviewed-preparation-recipe') }],
    probe: { async inspect() {
      return { status: control.prepared ? 'ready' : 'preparable', observedAt: Date.now(), checks: HOST_PREPARATION_CHECKS.map(id => ({ id,
        passed: id === 'packages' || id === 'runtime' ? control.prepared : id === 'node-cleanliness' ? !control.present : true })) };
    } },
  });
  const initialize = createKubeadmHostAction({ id: 'initialize-fixture-cluster', phase: 'initialize', binary: '/usr/bin/kubeadm',
    configurationFile: '/etc/footprint/fixture-init.yaml', configurationSha256: fixtureDigest('controlled-reviewed-initialization') });
  const network = createKubeadmHostAction({ id: 'configure-fixture-network', phase: 'network', binary: '/usr/bin/kubectl',
    kubeconfigFile: '/etc/kubernetes/admin.conf', configurationFile: '/etc/footprint/fixture-network.yaml', configurationSha256: fixtureDigest('controlled-reviewed-cni') });
  const actions = [...preparation.hostActions(fixtureHost.id), initialize, network];
  const transport = new LocalHostAccessTransport({ id: 'controlled-process-boundary', host: fixtureHost,
    actions: [HOST_INVENTORY_ACTION, ...actions], allowMutations: true,
    runner: async request => {
      if (request.input === HOST_INVENTORY_ACTION.script) { control.inventoryCalls++; return { code: 0, stdout: fixtureInventory(control) }; }
      assert.ok(request.input.includes(`if [ "$identity" != '${FIXTURE_IDENTITY}' ]`), 'the strict transport fences the physical host');
      const action = actions.find(action => request.input.endsWith(action.script));
      assert.ok(action, 'only a registered action reaches the controlled runner');
      control.actions.push(action.id);
      if (action.id === 'prepare-fixture-host') control.prepared = true;
      else if (action.id === initialize.id) { assert.ok(control.prepared); control.present = true; }
      else if (action.id === network.id) { assert.ok(control.present); control.networkReady = true; }
      return { code: 0, stdout: action.effect === 'mutating' && action.id !== 'prepare-fixture-host' ? KUBEADM_ACTION_COMPLETE + '\n' : '' };
    },
  });
  const connection = fixtureConnection(control);
  const lifecycle = new KubeadmClusterAdapter({ id: 'fixture-kubeadm', scope: fixtureScope, intent,
    hosts: [{ hostId: fixtureHost.id, transport, preparation, initializeActionId: initialize.id }], networkActionId: network.id, connection });
  return { control, intent, lifecycle, discovery: new FixedHostDiscovery({ transport }), connection };
}
