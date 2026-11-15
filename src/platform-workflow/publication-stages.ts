import { interrupt } from 'footprintjs';
import { readClusterObservation, readPublishedClusterAccess } from '../platform-bootstrap/data.ts';
import { readResourceHandle, readVerificationResult } from '../resource-flow/data.ts';
import { canonical } from '../util.ts';
import { contextFor, persist, safeStage, type PlatformStages } from './stages.ts';
import type { PlatformScope } from './scope.ts';

const identity = (value: unknown) => {
  const { id, kind, physicalId, scope } = readResourceHandle(value); return { id, kind, physicalId, scope };
};
export async function observeCluster(config: PlatformStages, stage: string) {
  const observation = readClusterObservation(await config.options.lifecycle.find(contextFor(config, stage)));
  if (observation.status !== 'present' || !observation.resource) throw Error('Platform cluster is not verified present');
  const resource = observation.resource;
  if (resource.id !== config.options.definition.resourceId || resource.scope !== config.options.definition.target.scope) throw Error('Platform physical target differs');
  const expected = config.state.resource ?? config.state.plan?.existingResource;
  if (expected && canonical(identity(expected)) !== canonical(identity(resource))) throw Error('Platform physical identity changed');
  return resource;
}
export function findPlatformStage(config: PlatformStages) {
  return safeStage(config, 'platform-resource-unverified', async scope => {
    config.state.resource = await observeCluster(config, 'find');
    scope.setValue('resource', config.state.resource); await persist(config);
  });
}
export function publishPlatformAccessStage(config: PlatformStages) {
  return async (scope: PlatformScope) => {
    let profileId: string | undefined;
    if (scope.getValue('awaitingProfile') !== true) {
      await safeStage(config, 'platform-publication-uncertain', async inner => {
        if (!config.state.resource || config.state.publicationStatus !== undefined) throw Error();
        // Private profile/Secret publication is an effect too; preserve its intent before invoking it.
        config.state.publicationStatus = 'started'; await persist(config);
        try {
          const published = await config.options.lifecycle.publishAccess(config.state.resource, contextFor(config, 'publish-access'));
          if (published !== undefined) profileId = readPublishedClusterAccess(published)!.profileId;
          config.state.publicationStatus = 'completed'; await persist(config);
          inner.setValue('awaitingProfile', !profileId);
        } catch {
          config.state.publicationStatus = 'uncertain'; await persist(config); throw Error();
        }
      })(scope);
    }
    if (!profileId) {
      scope.setValue('awaitingProfile', true);
      const answer = interrupt<{ profileId: string }>(scope, { reason: 'Register or choose a Kubernetes access profile', expects: { profileId: 'immutable-profile-id' } });
      if (!answer || Object.keys(answer).length !== 1 || typeof answer.profileId !== 'string') throw Error('Platform profile answer invalid');
      profileId = answer.profileId;
    }
    await safeStage(config, 'platform-access-profile-unverified', async inner => {
      if (!(await config.profileIds()).includes(profileId!) || config.options.hosts.some(host => host.profileId === profileId)) throw Error();
      await observeCluster(config, 'publish-access-identity');
      config.state.accessProfileId = profileId; inner.setValue('accessProfileId', profileId);
      inner.setValue('awaitingProfile', false); await persist(config);
    })(scope);
  };
}
export function verifyPlatformAccessStage(config: PlatformStages) {
  return safeStage(config, 'platform-access-verification-failed', async scope => {
    const resource = await observeCluster(config, 'verify-access-identity');
    const verification = readVerificationResult(await config.options.lifecycle.verify(resource, config.state.accessProfileId!, contextFor(config, 'verify-access')));
    scope.setValue('verification', verification); await persist(config);
    if (!verification.ok) throw Error();
  });
}
