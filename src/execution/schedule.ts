import type { Plan, PlannedOperation } from '../types.ts';
import type { OperationBatch } from './types.ts';

export function concurrencyLimit(value = 1): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) throw new Error('maxConcurrency must be an integer from 1 to 128');
  return value;
}

/** Bounded topological batches. A batch settles fully before the next one is admitted. */
export function scheduleOperations(plan: Plan, maxConcurrency: number): OperationBatch[] {
  const pending = plan.operations.filter(operation => operation.action !== 'delete');
  const planned = new Set(pending.map(operation => operation.resource.id));
  const completed = new Set<string>();
  const batches: OperationBatch[] = [];
  while (pending.length) {
    const ready = pending.filter(operation => (operation.resource.dependsOn ?? []).every(id => !planned.has(id) || completed.has(id))).slice(0, maxConcurrency);
    if (!ready.length) throw new Error('Resource dependency schedule cannot make progress');
    batches.push({ index: batches.length, operations: ready });
    for (const operation of ready) {
      completed.add(operation.resource.id);
      pending.splice(pending.indexOf(operation), 1);
    }
  }
  // Planner already placed deletes in reverse dependency order. Never parallelize pruning.
  for (const operation of plan.operations.filter(operation => operation.action === 'delete')) {
    batches.push({ index: batches.length, operations: [operation] });
  }
  return batches;
}
