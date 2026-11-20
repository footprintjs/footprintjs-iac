import { resolveResourceAttributes } from '../resource-attributes.ts';
import { assertProviderChange } from '../resource-change.ts';
import type { PlannedOperation, ResourceAdapter, StackState } from '../types.ts';
import { canonical, fingerprint } from '../util.ts';

/** Materialize only after the declared prerequisites finish. Keep the reviewed logical operation ID. */
export function resolveOperationInputs(operation: PlannedOperation, state: StackState, adapter: ResourceAdapter): PlannedOperation {
  const resolution = operation.inputResolution;
  if (!resolution) return operation;
  const spec = resolveResourceAttributes(operation.resource, id => state.resources[id]?.attributes ?? {});
  if (!spec) throw Error(`Provider inputs did not resolve for ${operation.resource.id}`);
  if ('spec' in resolution && canonical(resolution.spec) !== canonical(spec)) {
    throw Error(`Provider inputs changed after planning for ${operation.resource.id}; review again`);
  }
  const previous = state.resources[operation.resource.id];
  if (previous?.pending?.resolvedSpec && canonical(previous.pending.resolvedSpec) !== canonical(spec)) {
    throw Error(`Provider inputs changed during an unfinished operation for ${operation.resource.id}; reconcile the prior attempt first`);
  }
  const resource = { ...operation.resource, spec };
  if (previous) assertProviderChange(adapter, previous.resource, resource);
  return { ...operation, resource, desiredFingerprint: fingerprint(spec) };
}
