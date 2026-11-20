import { jsonCopy, object } from '../graph/data.ts';
import type { ManagedResource, Observation, PlannedOperation, ProviderContext, ResourceApplyReceipt, StackState } from '../types.ts';
import type { ExecutionPersistence } from './persistence.ts';

export function providerContext(state: StackState, resourceId: string, operationId: string, observed?: Observation): ProviderContext {
  const physicalId = observed?.physicalId ?? state.resources[resourceId]?.physicalId;
  return { stack: state.stack, operationId, ...(physicalId === undefined ? {} : { physicalId }) };
}

export function readProviderObservation(observation: Observation): Observation {
  if (observation.attributes === undefined) return observation;
  if (observation.exists !== true) throw Error('Missing resources cannot publish provider attributes');
  return { ...observation, attributes: object(jsonCopy(observation.attributes), 'observed resource attributes') };
}

export function pendingResource(previous: ManagedResource | undefined, operation: PlannedOperation, observed: Observation): ManagedResource {
  const physicalId = (observed.exists ? observed.physicalId : undefined) ?? previous?.physicalId;
  return {
    resource: previous?.resource ?? operation.resource, fingerprint: previous?.fingerprint ?? '',
    ...(physicalId === undefined ? {} : { physicalId }),
    pending: { operationId: operation.operationId, action: observed.exists ? 'update' : 'create',
      desiredFingerprint: operation.desiredFingerprint,
      ...(operation.inputResolution && { resolvedSpec: operation.resource.spec }) },
  };
}

export async function checkpointIdentity(receipt: void | ResourceApplyReceipt, state: StackState,
  resourceId: string, persistence: ExecutionPersistence): Promise<void> {
  if (receipt === undefined) return;
  if (!receipt || typeof receipt.physicalId !== 'string' || !receipt.physicalId.trim() || receipt.physicalId.length > 4096) {
    throw Error('Invalid provider apply receipt');
  }
  state.resources[resourceId]!.physicalId = receipt.physicalId;
  await persistence.save(state);
}

export function verifiedResource(operation: PlannedOperation, observed: Observation, previous?: ManagedResource): ManagedResource {
  if (observed.attributes !== undefined && observed.ready === false) {
    throw Error(`Provider attributes are not ready for ${operation.resource.id}`);
  }
  const physicalId = observed.physicalId ?? previous?.physicalId;
  return { resource: operation.resource, fingerprint: operation.desiredFingerprint,
    ...(physicalId === undefined ? {} : { physicalId }),
    ...(observed.attributes === undefined ? {} : { attributes: observed.attributes }) };
}
