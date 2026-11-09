import type { JsonObject, Plan, PlannedOperation } from '../types.ts';
import { errorMessage } from '../util.ts';
import type { ExecutionStage } from './scope.ts';
import type { OperationExecutor, OperationResult } from './types.ts';
import { recordProgress } from './progress.ts';

export function loadDesiredStage(plan: Plan, runId: string): ExecutionStage {
  return scope => {
    scope.setValue('failed', false);
    scope.setValue('failure', null);
    for (const operation of plan.operations) {
      scope.setValue(`desired:${operation.resource.id}`, operation.resource.spec);
      scope.setValue(`plan:${operation.resource.id}`, operation.action);
      recordProgress(scope, runId, operation, 'pending');
    }
  };
}

export function reconcileResourceStage(operation: PlannedOperation, execute: OperationExecutor, results: Record<string, unknown>, serial: boolean, runId: string): ExecutionStage {
  return async scope => {
    const id = operation.resource.id;
    // Borrowed runtime values stay at this boundary; provider ports receive detached JSON.
    const spec = structuredClone(scope.getValue(`desired:${id}`)) as JsonObject;
    void scope.getValue(`plan:${id}`);
    // Conservative scheduling context, not a claim that ordering alone proves semantic data use.
    for (const dependency of operation.resource.dependsOn ?? []) void scope.getValue(`result:${dependency}`);
    recordProgress(scope, runId, operation, 'deploying');
    let result: OperationResult;
    try { result = await execute({ ...operation, resource: { ...operation.resource, spec } }); }
    catch (error) { result = { status: 'failed', message: errorMessage(error) }; }
    scope.publishResult(id, result);
    results[id] = result;
    recordProgress(scope, runId, operation,
      result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : operation.action === 'delete' ? 'deleted' : 'ready',
      result.status === 'failed' ? result.message : undefined);
    if (serial && result.status === 'failed') {
      scope.setValue('failure', { resourceId: id, message: result.message });
      scope.setValue('failed', true);
    }
  };
}

export function skipResourceStage(operation: PlannedOperation, results: Record<string, unknown>, runId: string): ExecutionStage {
  return scope => {
    scope.publishResult(operation.resource.id, { status: 'skipped', reason: scope.failure });
    results[operation.resource.id] = { status: 'skipped' };
    recordProgress(scope, runId, operation, 'skipped', 'A preceding operation failed');
  };
}
