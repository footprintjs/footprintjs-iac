import { fingerprint } from '../util.ts';
import type { PipelineDefinition, PipelineOperation, PipelineStageState, RolloutPlan } from './types.ts';
import type { ReleaseManifest } from '../releases/types.ts';

export function recordedPipelineDefinition(definition:PipelineDefinition,release:ReleaseManifest,stageId:string,plan:RolloutPlan){
  const stage=definition.stages.find(stage=>stage.id===stageId)!;
  return {id:definition.id,configurationDigest:definition.configurationDigest,stageId,targetId:stage.target.id,targetDigest:fingerprint(stage.target),
    strategyId:stage.strategyId,adapterId:stage.adapterId,rollback:stage.rollback,promotion:stage.promotion,
    release:{id:release.id,digest:release.digest,artifacts:release.artifacts.map(({id,digest})=>({id,digest}))},
    plan:plan.steps.map(step=>({id:step.id,kind:step.kind,...(step.kind==='action'?{operation:step.operation,...(step.parameters?{parametersDigest:fingerprint(step.parameters)}:{})}:{})})),
    checks:stage.checks.map(({runnerId,suiteId,suiteDigest})=>({runnerId,suiteId,suiteDigest}))};
}
export function recordedOperation(operation:PipelineOperation){
  return {id:operation.id,kind:operation.kind,status:operation.status,releaseDigest:operation.releaseDigest,
    ...(operation.operation?{operation:operation.operation}:{}),
    ...(operation.receipt?{receipt:{status:operation.receipt.status,...(operation.receipt.changes?{changes:operation.receipt.changes}:{}),...(operation.receipt.evidence?{evidence:operation.receipt.evidence}:{})}}:{}),
    ...(operation.check?{check:{suiteId:operation.check.request.suiteId,suiteDigest:operation.check.request.suiteDigest,reason:operation.check.request.reason,
      status:operation.check.status,checks:operation.check.checks.map(({id,status})=>({id,status}))}}:{}),
    ...(operation.observation?{observation:operation.observation}:{})};
}
export function recordedStage(stage:PipelineStageState){
  return {id:stage.id,status:stage.status,phase:stage.phase,operations:stage.operations.map(recordedOperation),
    ...(stage.baseline?{baselineDigest:stage.baseline.release.digest}:{}),...(stage.lastApplied?{lastApplied:stage.lastApplied}:{}),...(stage.lastVerified?{lastVerified:stage.lastVerified}:{})};
}
