import { readResourceHandle, readVerificationResult } from '../resource-flow/data.ts';
import type { ResourceHandle, VerificationResult } from '../resource-flow/types.ts';
import { canonical } from '../util.ts';
import { normalizedPlatformVersion, readBootstrapContext, readClusterObservation, readPublishedClusterAccess } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import type { BootstrapContext, ClusterConnectionPort, ClusterObservation, PublishedClusterAccess } from './types.ts';

export const CLUSTER_VERIFICATION_CHECKS = ['api', 'nodes-ready', 'system-pods-ready', 'cni-ready'] as const;
export function sameCluster(left: ResourceHandle, right: ResourceHandle): boolean {
  const identity = ({ id, kind, physicalId, scope }: ResourceHandle) => ({ id, kind, physicalId, scope });
  return canonical(identity(left)) === canonical(identity(right));
}
export async function inspectCluster(connection: ClusterConnectionPort, id: string, scope: string, context: BootstrapContext): Promise<ClusterObservation> {
  try {
    const observed = readClusterObservation(await connection.inspect(readBootstrapContext(context)));
    if (observed.resource && (observed.resource.id !== id || observed.resource.scope !== scope)) throw Error();
    return observed;
  } catch { throw new ClusterBootstrapAdapterError('cluster-observation-unavailable'); }
}
async function current(connection: ClusterConnectionPort, resource: ResourceHandle, context: BootstrapContext, expectedVersion?: string): Promise<ResourceHandle> {
  const admitted = readResourceHandle(resource), observed = await inspectCluster(connection, admitted.id, admitted.scope, context);
  if (observed.status !== 'present' || !sameCluster(admitted, observed.resource!)) throw new ClusterBootstrapAdapterError('cluster-identity-changed');
  if (expectedVersion !== undefined && normalizedPlatformVersion(observed.platformVersion) !== expectedVersion) throw new ClusterBootstrapAdapterError('cluster-version-unverified');
  return admitted;
}
export async function publishClusterAccess(connection: ClusterConnectionPort, resource: ResourceHandle, context: BootstrapContext, expectedVersion: string): Promise<PublishedClusterAccess | undefined> {
  const admitted = await current(connection, resource, context, expectedVersion);
  try { return readPublishedClusterAccess(await connection.publishAccess(admitted, readBootstrapContext(context))); }
  catch { throw new ClusterBootstrapAdapterError('cluster-access-publication-unavailable'); }
}
export async function verifyClusterConnection(connection: ClusterConnectionPort, resource: ResourceHandle, profileId: string, context: BootstrapContext, expectedVersion: string): Promise<VerificationResult> {
  const admitted = await current(connection, resource, context);
  const before = await inspectCluster(connection, admitted.id, admitted.scope, context);
  if (before.status !== 'present' || !sameCluster(admitted, before.resource!) || normalizedPlatformVersion(before.platformVersion) !== expectedVersion) return { ok: false, checks: [{ id: 'platform-version', passed: false }] };
  let result: VerificationResult;
  try { result = readVerificationResult(await connection.verify(admitted, profileId, readBootstrapContext(context))); }
  catch { throw new ClusterBootstrapAdapterError('cluster-verification-unavailable'); }
  const passed = new Set(result.checks.filter(check => check.passed).map(check => check.id));
  if (!result.ok || CLUSTER_VERIFICATION_CHECKS.some(id => !passed.has(id))) return { ok: false,
    checks: CLUSTER_VERIFICATION_CHECKS.map(id => ({ id, passed: passed.has(id) })) };
  const after = await inspectCluster(connection, admitted.id, admitted.scope, context);
  if (after.status !== 'present' || !sameCluster(admitted, after.resource!) || normalizedPlatformVersion(after.platformVersion) !== expectedVersion) return { ok: false, checks: [{ id: 'platform-version', passed: false }] };
  return { ok: true, checks: [{ id: 'platform-version', passed: true }, ...CLUSTER_VERIFICATION_CHECKS.map(id => ({ id, passed: true }))], ...(result.receipts ? { receipts: result.receipts } : {}) };
}
