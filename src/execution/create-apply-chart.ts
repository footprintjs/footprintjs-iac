import { decide, flowChart } from 'footprintjs';
import type { Plan } from '../types.ts';
import { executionBranch, joinBatchStage, selectBatchStage, skipBatchBranch, skipBatchStage } from './batch-stages.ts';
import { loadDesiredStage, reconcileResourceStage, skipResourceStage } from './resource-stages.ts';
import { scheduleOperations } from './schedule.ts';
import { executionScopeFactory, type ExecutionScope } from './scope.ts';
import type { OperationExecutor } from './types.ts';
import type { DeploymentResourceStages } from '../progress/chart.ts';
import type { OperationResult } from './types.ts';
import type { PlannedOperation } from '../types.ts';

const inputMapper=(operation:PlannedOperation)=>(value:unknown)=>{
  const scope=value as Record<string,unknown>;
  return {desiredSpec:scope[`desired:${operation.resource.id}`],planAction:scope[`plan:${operation.resource.id}`],
    dependencyResults:(operation.resource.dependsOn??[]).map(id=>scope[`result:${id}`])};
};
const outputMapper=(serial:boolean,id:string)=>(value:unknown):Record<string,unknown>=>{
  const output=value as Record<string,unknown>,result=output.operationResult as OperationResult|undefined;
  return { [`result:${id}`]:result,[`progress:${id}`]:output[`progress:${id}`],
    ...(serial&&result?.status==='failed'?{failed:true,failure:{resourceId:id,message:result.message}}:{}) };
};

/** The only file that assembles the native apply chart; stage behavior lives beside it. */
export function createApplyChart(plan: Plan, execute: OperationExecutor, results: Record<string, unknown>, maxConcurrency: number, runId: string) {
  const resources: DeploymentResourceStages[] = [];
  let native = false;
  let chart = flowChart<void, ExecutionScope>('Load desired resources', loadDesiredStage(plan, runId), 'load-desired')
    .setScopeFactory(executionScopeFactory);
  for (const batch of scheduleOperations(plan, maxConcurrency)) {
    for (const operation of batch.operations) resources.push({ resourceId: operation.resource.id, action: operation.action, batchIndex: batch.index,
      executeStageId: executionBranch(operation.resource.id),
      gateStageId: batch.operations.length === 1 ? `gate-${operation.resource.id}` : `gate-batch-${batch.index}`,
      skipStageId: batch.operations.length === 1 ? `skip-${operation.resource.id}` : skipBatchBranch(batch.index),
      ...(batch.operations.length > 1 ? { joinStageId: `join-batch-${batch.index}` } : {}) });
    if (batch.operations.length === 1) {
      const operation = batch.operations[0]!;
      const id = operation.resource.id;
      const child=execute.createFlow?.(operation,results,true);native ||= !!child;
      const gate = chart.addDeciderFunction(`Can proceed: ${id}`, scope => decide(scope, [
        { when: { failed: { eq: false } }, then: executionBranch(id), label: 'No preceding operation failed' },
      ], `skip-${id}`), `gate-${id}`);
      if(child)gate.addSubFlowChartBranch(executionBranch(id),child,`Reconcile ${id}`,{inputMapper:inputMapper(operation),outputMapper:outputMapper(true,id)});
      else gate.addFunctionBranch(executionBranch(id), `Reconcile ${id}`, reconcileResourceStage(operation, execute, results, true, runId));
      chart=gate.addFunctionBranch(`skip-${id}`, `Skip ${id}`, skipResourceStage(operation, results, runId))
        .setDefault(`skip-${id}`).end();
      continue;
    }
    const selector = chart.addSelectorFunction(`Can proceed: batch ${batch.index}`, selectBatchStage(batch), `gate-batch-${batch.index}`);
    for (const operation of batch.operations) {
      const child=execute.createFlow?.(operation,results,false);native ||= !!child;
      if(child)selector.addSubFlowChartBranch(executionBranch(operation.resource.id),child,`Reconcile ${operation.resource.id}`,{inputMapper:inputMapper(operation),outputMapper:outputMapper(false,operation.resource.id)});
      else selector.addFunctionBranch(executionBranch(operation.resource.id), `Reconcile ${operation.resource.id}`, reconcileResourceStage(operation, execute, results, false, runId));
    }
    selector.addFunctionBranch(skipBatchBranch(batch.index), `Skip batch ${batch.index}`, skipBatchStage(batch, results, runId));
    chart = selector.end().addFunction(`Join batch ${batch.index}`, joinBatchStage(batch, results), `join-batch-${batch.index}`);
  }
  return { chart: chart.build(), resources, native };
}
