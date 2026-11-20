import { decide, flowChart } from 'footprintjs';
import type { OperationExecutionOptions } from './execute-operation.ts';
import type { PlannedOperation } from '../types.ts';
import { NativeOperation } from './native-operation.ts';
import { executionScopeFactory, type ExecutionScope } from './scope.ts';
import { recordProgress } from './progress.ts';
import { createAdapterFlowChart } from '../adapter-flow/create-chart.ts';

/** A native lifecycle mount: every adapter effect is below the durable-intent stage. */
export function createNativeOperationChart(operation:PlannedOperation,options:OperationExecutionOptions,results:Record<string,unknown>) {
  const session=new NativeOperation(operation,options),binding={deploymentRunId:options.runId,adapterId:session.adapter.name,resourceId:operation.resource.id,operationId:operation.operationId};
  const effect=session.adapter.createApplyFlow?.(operation.resource,session.context,binding)
    ??createAdapterFlowChart(binding,[{id:'opaque-provider-apply',name:'Run registered apply callback (opaque)',phase:'apply',run:()=>session.apply()}]);
  const verification=session.adapter.createVerifyFlow?.(operation.resource,session.context,binding);
  let chart=flowChart<void,ExecutionScope>('Begin resource operation',async scope=>{
    await session.begin(scope);recordProgress(scope,options.runId,operation,'deploying');
  },'native-begin').setScopeFactory(executionScopeFactory)
    .addFunction('Inspect resource',scope=>session.inspect(scope),'native-inspect')
    .addFunction('Persist intended change',scope=>session.intent(scope),'native-intent')
    .addDeciderFunction('Is a provider change required?',scope=>decide(scope,[{when:{nativeNeedsEffect:{eq:true}},then:'native-effect',label:'Durable change intent saved'}],'native-unchanged'),'native-effect-gate')
      .addSubFlowChartBranch('native-effect',effect,'Provider operation',{
        inputMapper:scope=>({adapterFlowInput:(scope as Record<string,unknown>).nativeIntent}),
        outputMapper:output=>({adapterFlowOutcome:(output as Record<string,unknown>).adapterFlowOutcome}),
      })
      .addFunctionBranch('native-unchanged','No provider mutation',()=>undefined).setDefault('native-unchanged').end()
    .addFunction('Read provider outcome',scope=>session.acceptEffect(scope),'native-effect-outcome')
    .addFunction('Wait and observe resource readiness',scope=>session.verify(scope),'native-verify');
  if(verification)chart=chart.addDeciderFunction('May component verification run?',scope=>decide(scope,[{when:{nativeHasError:{eq:false}},then:'native-component-verify',label:'Resource readiness observed'}],'native-component-unknown'),'native-verification-gate')
    .addSubFlowChartBranch('native-component-verify',verification,'Observe registered components',{
      inputMapper:scope=>({adapterFlowInput:(scope as Record<string,unknown>).nativeVerifiedObservation}),
      outputMapper:output=>({verificationFlowOutcome:(output as Record<string,unknown>).adapterFlowOutcome}),
    }).addFunctionBranch('native-component-unknown','Do not assert component readiness',()=>undefined).setDefault('native-component-unknown').end()
      .addFunction('Read component observation outcome',scope=>session.acceptVerification(scope),'native-verification-outcome');
  return chart.addFunction('Checkpoint verified resource',scope=>session.checkpoint(scope),'native-checkpoint')
    .addFunction('Reconcile uncertain outcome',scope=>session.recover(scope),'native-recover')
    .addDeciderFunction('May this provider safely retry?',scope=>decide(scope,[{when:{nativeRetry:{eq:true}},then:'native-retry',label:'Explicit provider retry capability and strategy'}],'native-settled'),'native-retry-gate')
      .addFunctionBranch('native-retry','Retry from a fresh observation',()=>undefined,undefined,{loopTo:'native-inspect'})
      .addFunctionBranch('native-settled','Operation settled',()=>undefined).setDefault('native-settled').end()
    .addFunction('Publish resource result',async scope=>{
      const result=await session.finish(scope);scope.setValue('operationResult',result);scope.publishResult(operation.resource.id,result);results[operation.resource.id]=result;
      recordProgress(scope,options.runId,operation,result.status==='complete'?'ready':'failed',result.status==='failed'?result.message:undefined);
    },'native-result').build();
}
