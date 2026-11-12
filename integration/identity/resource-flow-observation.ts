import { join } from 'node:path';
import type { CommandRunner } from '../../src/providers/kubernetes.ts';
import { runKubectl } from '../../src/providers/kubernetes.ts';
import { canonical, fingerprint } from '../../src/util.ts';
import { IdentityFixtureAdapter } from './docker-adapter.ts';
import { createNeoAcquisitionGraph } from './create-acquisition-graph.ts';
import { assertFederationRoute, observeIdentityFixture, type IdentityFixtureObservation } from './connections/fixture.ts';
import { loadIdentityTarget, type IdentityTarget } from './target.ts';

export type NeoFlowIdentityObservation = IdentityFixtureObservation;
export interface NeoFlowObservationOptions {
  loadTarget?: typeof loadIdentityTarget;
  runner?: CommandRunner;
}
export function neoFlowTargetScope(target: IdentityTarget): string {
  return fingerprint({ id: target.id, context: target.context, kubeconfig: target.kubeconfig, namespace: target.namespace,
    providerName: target.providerName, directoryName: target.directoryName, providerPort: target.providerPort,
    ldapPort: target.ldapPort, neoPort: target.neoPort, fixtureDigest: target.fixtureDigest,
    images: target.images, sourceCommit: target.sourceCommit ?? null });
}
export function neoFlowPhysicalId(observation: NeoFlowIdentityObservation): string {
  return fingerprint({ directory: observation.directory.id, provider: observation.provider.id });
}

/** Existing is an explicitly scoped read: it never calls an engine, apply, delete or import. */
export async function observeNeoFlowIdentity(target: IdentityTarget, options: NeoFlowObservationOptions = {}): Promise<NeoFlowIdentityObservation> {
  const runner = options.runner ?? runKubectl;
  const selected = await (options.loadTarget ?? loadIdentityTarget)(join(target.directory, 'target.json'));
  if (canonical(selected) !== canonical(target)) throw Error('Neo connection target changed');
  await assertFederationRoute(target);
  const command = async (program: string, args: string[], timeoutMs = 30000) => (await runner(program, args, { timeoutMs })).stdout.trim();
  const fixture = new IdentityFixtureAdapter(target.id, command);
  const graph = createNeoAcquisitionGraph(target);
  const observed = await observeIdentityFixture(target, graph.resources, graph.name, fixture, runner);
  if (!observed.directory.running || !observed.provider.running) throw Error('The referenced identity services are not running');
  return observed;
}
