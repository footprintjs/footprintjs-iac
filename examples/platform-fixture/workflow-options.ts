import type { BootstrapIntent, ClusterLifecycleAdapter, HostDiscoveryPort, PlatformWorkflowOptions } from '../../src/platform/index.ts';
import { fixtureClusterProfile, fixtureHost, fixtureResource, fixtureScope } from './connection.ts';
import { fixtureDigest, type FixtureControl } from './inventory.ts';

export function fixtureWorkflowOptions(input: {
  directory: string; intent: BootstrapIntent; lifecycle: ClusterLifecycleAdapter; discovery?: HostDiscoveryPort;
  control: FixtureControl; profiles: { id: string; label: string }[];
}): PlatformWorkflowOptions {
  return {
    definition: { id: 'fixture-platform-' + input.intent.mode, label: 'Controlled ' + input.intent.mode + ' example', resourceId: fixtureResource.id,
      mode: input.intent.mode, target: { id: 'fixture-platform-target', scope: fixtureScope }, configurationDigest: fixtureDigest('controlled-platform-config-' + input.intent.mode) },
    intent: input.intent, hosts: input.intent.mode === 'create' ? [fixtureHost] : [], lifecycle: input.lifecycle,
    ...(input.discovery ? { discovery: input.discovery } : {}), directory: input.directory,
    profiles: async () => input.profiles, profileCatalogId: 'fixture-immutable-kubernetes-profiles',
    async resolveDetails(resource, profileId) {
      if (profileId !== fixtureClusterProfile.id) throw Error('Only the fixture Kubernetes profile is registered');
      return { resourceId: resource.id, profileId, protocol: 'kubernetes', endpoint: 'https://controlled-fixture.invalid:6443',
        credentialRef: 'opaque-controlled-fixture-credential', trustRef: 'opaque-controlled-fixture-ca' };
    },
    async connect() { input.control.connects++; return { id: 'controlled-connection-' + input.intent.mode }; },
  };
}
