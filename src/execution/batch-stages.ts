import { select } from 'footprintjs';
import type { ExecutionScope, ExecutionStage } from './scope.ts';
import type { OperationBatch, OperationResult } from './types.ts';
import { recordProgress } from './progress.ts';
import { recordFailureGate } from './schedule-evidence.ts';

export const executionBranch = (resourceId: string) => `execute-${resourceId}`;
export const skipBatchBranch = (index: number) => `skip-batch-${index}`;

export function selectBatchStage(batch: OperationBatch) {
  return (scope: ExecutionScope) => {
    for (const { resource } of batch.operations) void scope.getValue(`schedule:${resource.id}`);
    return select(scope, [
      ...batch.operations.map(operation => ({ when: { failed: { eq: false } }, then: executionBranch(operation.resource.id), label: `No preceding operation failed: ${operation.resource.id}` })),
      { when: { failed: { eq: true } }, then: skipBatchBranch(batch.index), label: 'A preceding operation failed' },
    ]);
  };
}

export function skipBatchStage(batch: OperationBatch, results: Record<string, unknown>, runId: string): ExecutionStage {
  return scope => {
    for (const operation of batch.operations) {
      recordFailureGate(scope, operation.resource.id);
      scope.publishResult(operation.resource.id, { status: 'skipped', reason: scope.failure });
      results[operation.resource.id] = { status: 'skipped' };
      recordProgress(scope, runId, operation, 'skipped', 'A preceding operation failed');
    }
  };
}

/** Native fork settlement precedes this join; read disjoint child results exactly. */
export function joinBatchStage(batch: OperationBatch, results: Record<string, unknown>): ExecutionStage {
  return scope => {
    for (const operation of batch.operations) {
      const id = operation.resource.id;
      const saved = scope.getValue(`result:${id}`);
      const result: OperationResult = saved && typeof saved === 'object'
        ? structuredClone(saved) as OperationResult
        : { status: 'failed', message: `Parallel stage did not record a result: ${id}` };
      results[id] = result.status === 'skipped' ? { status: 'skipped' } : result;
      if (result.status === 'failed' && !scope.failed) {
        scope.setValue('failure', { resourceId: id, message: result.message });
        scope.setValue('failed', true);
      }
    }
  };
}
