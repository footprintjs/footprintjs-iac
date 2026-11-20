import { resourceAttributeSources } from '../resource-attributes.ts';
import type { ScheduleReasons } from '../progress/schedule-reasons.ts';
import type { OperationBatch } from './types.ts';
import type { ExecutionScope } from './scope.ts';

/** Explain the selected batches without changing their membership or order. */
export function explainBatches(batches: readonly OperationBatch[], limit: number): ReadonlyMap<string, ScheduleReasons> {
  const byId = new Map(batches.flatMap(batch => batch.operations.map(operation => [operation.resource.id, batch.index] as const)));
  const reasons = new Map<string, ScheduleReasons>();
  for (const { index, operations } of batches) for (const { resource, action } of operations) {
    const attributes = action === 'delete' ? new Map<string, string[]>() : resourceAttributeSources(resource);
    const dependencies = action === 'delete' ? [] : (resource.dependsOn ?? []).map(resourceId => ({
      resourceId, attributes: attributes.get(resourceId) ?? [],
    }));
    const firstEligible = Math.max(0, ...dependencies.map(({ resourceId }) => (byId.get(resourceId) ?? -1) + 1));
    reasons.set(resource.id, { dependencies,
      ...(action !== 'delete' && firstEligible < index && { capacity: { fromBatch: firstEligible, throughBatch: index - 1, limit } }),
      ...(index > 0 && { batchBarrier: index - 1 }) });
  }
  return reasons;
}

export function recordFailureGate(scope: ExecutionScope, resourceId: string) {
  void scope.getValue(`schedule:${resourceId}`);
  const failure = scope.failure;
  scope.publishScheduleOutcome(resourceId, { kind: 'failure-gate', ...(failure?.resourceId && { resourceId: failure.resourceId }) });
  // Attribute the skipped progress write to the recorded decision.
  void scope.getValue(`schedule-outcome:${resourceId}`);
}
