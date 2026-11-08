import { decide, flowChart } from 'footprintjs';
import type { Plan } from '../types.ts';
import { executionBranch, joinBatchStage, selectBatchStage, skipBatchBranch, skipBatchStage } from './batch-stages.ts';
import { loadDesiredStage, reconcileResourceStage, skipResourceStage } from './resource-stages.ts';
import { scheduleOperations } from './schedule.ts';
import { executionScopeFactory, type ExecutionScope } from './scope.ts';
import type { OperationExecutor } from './types.ts';

/** The only file that assembles the native apply chart; stage behavior lives beside it. */
export function createApplyChart(plan: Plan, execute: OperationExecutor, results: Record<string, unknown>, maxConcurrency: number) {
  let chart = flowChart<void, ExecutionScope>('Load desired resources', loadDesiredStage(plan), 'load-desired')
    .setScopeFactory(executionScopeFactory);
  for (const batch of scheduleOperations(plan, maxConcurrency)) {
    if (batch.operations.length === 1) {
      const operation = batch.operations[0]!;
      const id = operation.resource.id;
      chart = chart.addDeciderFunction(`Can proceed: ${id}`, scope => decide(scope, [
        { when: { failed: { eq: false } }, then: executionBranch(id), label: 'No preceding operation failed' },
      ], `skip-${id}`), `gate-${id}`)
        .addFunctionBranch(executionBranch(id), `Reconcile ${id}`, reconcileResourceStage(operation, execute, results, true))
        .addFunctionBranch(`skip-${id}`, `Skip ${id}`, skipResourceStage(operation, results))
        .setDefault(`skip-${id}`).end();
      continue;
    }
    const selector = chart.addSelectorFunction(`Can proceed: batch ${batch.index}`, selectBatchStage(batch), `gate-batch-${batch.index}`);
    for (const operation of batch.operations) selector.addFunctionBranch(
      executionBranch(operation.resource.id), `Reconcile ${operation.resource.id}`, reconcileResourceStage(operation, execute, results, false));
    selector.addFunctionBranch(skipBatchBranch(batch.index), `Skip batch ${batch.index}`, skipBatchStage(batch, results));
    chart = selector.end().addFunction(`Join batch ${batch.index}`, joinBatchStage(batch, results), `join-batch-${batch.index}`);
  }
  return chart.build();
}
