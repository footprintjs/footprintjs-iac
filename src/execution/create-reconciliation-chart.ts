import { flowChart } from 'footprintjs';
import { executionScopeFactory, type ExecutionScope } from './scope.ts';
import type { ResourceOutcomeInspection, PlannedOperation } from '../types.ts';

/** Reconciliation only observes the already-recorded operation; it cannot run an apply branch. */
export function createReconciliationChart(originalRunId:string, operations:readonly PlannedOperation[], inspect:(operation:PlannedOperation)=>Promise<ResourceOutcomeInspection>) {
  let chart=flowChart<void,ExecutionScope>('Load uncertain operation',scope=>{
    scope.setValue('originalRunId',originalRunId);
    scope.setValue('operationIds',operations.map(operation=>operation.operationId));
  },'load-uncertain-operation').setScopeFactory(executionScopeFactory);
  for(const operation of operations) chart=chart.addFunction(`Inspect outcome: ${operation.resource.id}`,async scope=>{
    let inspection:ResourceOutcomeInspection|null=null;
    try{inspection=await inspect(operation);}catch{/* Missing observations preserve the pending intent. */}
    scope.setValue(`inspection:${operation.resource.id}`,inspection);
  },`inspect-outcome-${operation.resource.id}`);
  chart=chart.addFunction('Decide whether failure is known',scope=>{
    const knownFailed=operations.length>0&&operations.every(operation=>{
      const inspection=scope.getValue(`inspection:${operation.resource.id}`) as ResourceOutcomeInspection|null;
      return inspection?.runtimeControlReturned===true&&inspection.quiescent===true
        &&inspection.observation.exists===true&&inspection.observation.owned===true&&inspection.observation.ready===false;
    });
    scope.setValue('outcome',knownFailed?'failed':'unknown');
  },'settle-known-failure');
  return chart.build();
}
