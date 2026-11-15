import { CLUSTER_VERIFICATION_CHECKS, type ClusterConnectionPort, type HostRef } from '../../src/platform/index.ts';
import type { FixtureControl } from './inventory.ts';

export const fixtureHost: HostRef = { id: 'fixture-server-a', scope: 'controlled-fixture-server', profileId: 'fixture-management-access' };
export const fixtureScope = 'controlled-fixture-cluster';
export const fixtureResource = { id: 'fixture-cluster-a', kind: 'kubernetes-cluster', physicalId: 'controlled-fixture-api-uid', scope: fixtureScope };
export const fixtureClusterProfile = { id: 'fixture-kubernetes-access', label: 'Controlled fixture Kubernetes profile' };

/** In-memory access port. A production composition must measure these conditions at its real target. */
export function fixtureConnection(control: FixtureControl): ClusterConnectionPort {
  return {
    async inspect() { control.inspections++; return control.present ? { status: 'present', resource: fixtureResource, platformVersion: control.version } : { status: 'absent' }; },
    async publishAccess() { return undefined; }, // Demonstrate the real native human checkpoint.
    async verify(resource, profileId) {
      const eligible = resource.physicalId === fixtureResource.physicalId && profileId === fixtureClusterProfile.id
        && control.prepared && control.present && control.networkReady && control.version === '1.35.0';
      return { ok: eligible, checks: CLUSTER_VERIFICATION_CHECKS.map(id => ({ id, passed: eligible })) };
    },
  };
}
