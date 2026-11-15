import { canonical, fingerprint } from '../util.ts';
import { readCheckRequest, readCheckResult } from '../checks/data.ts';
import type { CheckRunner } from '../checks/types.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import { readReleaseObservation, readRolloutReceipt } from './data.ts';
import { recordedOperation, recordedPipelineDefinition, recordedStage } from './summary.ts';
import type { PipelineScope, PipelineStageFunction } from './scope.ts';
import type { PipelineTargetState } from './store.ts';
import { PIPELINE_EVENT, type PipelineDefinition, type PipelineOperation, type PipelineStageDefinition, type PipelineState, type RolloutAction, type RolloutAdapter, type RolloutContext, type RolloutPlan } from './types.ts';

export interface PipelineStages {
  definition:PipelineDefinition;definitionDigest:string;release:ReleaseManifest;state:PipelineState;stage:PipelineStageDefinition;
  plan:RolloutPlan;adapter:RolloutAdapter;checks:ReadonlyMap<string,CheckRunner>;target:PipelineTargetState;
  approved:boolean;recovery:boolean;blocked:boolean;uncertain:boolean;
  persist():Promise<void>;persistTarget():Promise<void>;
}
function current(config:PipelineStages){return config.state.stages.find(stage=>stage.id===config.stage.id)!;}
function context(config:PipelineStages,id:string):RolloutContext{return Object.freeze({executionId:config.state.executionId!,operationId:fingerprint({executionId:config.state.executionId,stageId:config.stage.id,id}),definitionDigest:config.definitionDigest,stageId:config.stage.id,target:config.stage.target});}
function release(config:PipelineStages):ReleaseManifest{return config.recovery?current(config).baseline!.release:config.release;}
async function progress(scope:PipelineScope,config:PipelineStages,phase:string,status:'running'|'passed'|'failed'|'incomplete'|'rolled-back'){
  const state=current(config);state.phase=phase;
  scope.setValue('stage',recordedStage(state));
  scope.emitEvent(PIPELINE_EVENT,{executionId:config.state.executionId,stageId:config.stage.id,phase,status});
  await config.persist();
}
function consume(scope:PipelineScope,config:PipelineStages){
  if(scope.getValue('definitionDigest')!==config.definitionDigest||canonical(scope.getValue('definition'))!==canonical(recordedPipelineDefinition(config.definition,config.release,config.stage.id,config.plan)))throw Error('Pipeline native definition binding changed');
  scope.getValue('stage');
}
async function intent(scope:PipelineScope,config:PipelineStages,operation:PipelineOperation){
  current(config).operations.push(operation);
  if(operation.kind==='action'){
    config.target.pending={executionId:config.state.executionId!,stageId:config.stage.id,operationId:context(config,operation.id).operationId,releaseDigest:operation.releaseDigest};
    await config.persistTarget();
  }
  await progress(scope,config,operation.id,'running');
}
async function observe(scope:PipelineScope,config:PipelineStages,id:string,initial=false){
  const state=current(config),desired=release(config),operation:PipelineOperation={id,kind:'observe',status:'intent',releaseDigest:desired.digest};
  await intent(scope,config,operation);
  try{operation.observation=readReleaseObservation(await config.adapter.observe(context(config,id)));operation.status=operation.observation.known?'succeeded':'unknown';}
  catch{operation.status='unknown';}
  if(operation.status==='unknown'){config.blocked=true;config.uncertain=true;}
  else {
    const actual=operation.observation!.releaseDigest;
    if(initial){
      if(config.target.pending||config.target.lastApplied&&actual!==config.target.lastApplied.digest){config.blocked=true;config.uncertain=true;}
      if(config.recovery&&config.target.lastExecutionId!==config.state.executionId){config.blocked=true;config.uncertain=true;}
    }else if(actual===desired.digest){config.target.lastApplied=desired;state.lastApplied=desired.digest;}
    else if(state.baseline&&actual===state.baseline.release.digest){config.target.lastApplied=state.baseline.release;state.lastApplied=actual;}
    else if(actual===null){delete config.target.lastApplied;delete state.lastApplied;}
    else{config.blocked=true;config.uncertain=true;}
    if(!initial&&!config.uncertain)delete config.target.pending;
    config.target.lastExecutionId=config.state.executionId!;await config.persistTarget();
  }
  scope.setValue('operation:'+id,recordedOperation(operation));
  await progress(scope,config,id,operation.status==='succeeded'?'passed':'incomplete');
  return operation.observation;
}
export function initializePipelineStage(config:PipelineStages):PipelineStageFunction{return async scope=>{
  const state=current(config);scope.setValue('definition',recordedPipelineDefinition(config.definition,config.release,config.stage.id,config.plan));
  scope.setValue('definitionDigest',config.definitionDigest);scope.setValue('executionId',config.state.executionId);scope.setValue('releaseDigest',release(config).digest);
  scope.setValue('continuation',{kind:config.recovery?'recovery':'rollout',previousRunIds:config.state.recordings.filter(item=>item.stageId===config.stage.id).map(item=>item.runId)});
  if(!config.approved){state.status='waiting';state.phase='Awaiting promotion';await progress(scope,config,'promotion-gate','passed');return;}
  state.status='running';
  if(!config.recovery){
    if(config.target.lastVerified)state.baseline=config.target.lastVerified;
    if(config.target.lastApplied)state.lastApplied=config.target.lastApplied.digest;
    if(config.target.lastVerified)state.lastVerified=config.target.lastVerified.release.digest;
  }
  await progress(scope,config,config.recovery?'recovery-start':'rollout-start','running');
  await observe(scope,config,config.recovery?'recovery-before':'before',true);
  if(!config.recovery&&config.stage.rollback!=='disabled'&&!state.baseline){config.blocked=true;await progress(scope,config,'verified-baseline-required','failed');}
};}
export function canRunStage(config:PipelineStages,run='run',skip='skip'){return (scope:PipelineScope)=>{consume(scope,config);return config.approved&&!config.blocked?run:skip;};}
export function skipPipelineStep(config:PipelineStages,id:string):PipelineStageFunction{return async scope=>{consume(scope,config);scope.setValue('skipped:'+id,{reason:!config.approved?'promotion-required':config.uncertain?'uncertain-outcome':'earlier-failure'});};}
export function rolloutActionStage(config:PipelineStages,action:RolloutAction):PipelineStageFunction{return async scope=>{
  consume(scope,config);const id=(config.recovery?'recovery-':'')+action.id,desired=release(config);
  const operation:PipelineOperation={id,kind:'action',status:'intent',operation:action.operation,releaseDigest:desired.digest};
  await intent(scope,config,operation);
  try{operation.receipt=readRolloutReceipt(await config.adapter.execute(action,desired,context(config,id)));operation.status=operation.receipt.status;}
  catch{operation.status='unknown';}
  if(operation.status!=='succeeded'){config.blocked=true;config.uncertain=operation.status==='unknown';}
  scope.setValue('operation:'+id,recordedOperation(operation));
  await progress(scope,config,id,operation.status==='succeeded'?'passed':operation.status==='unknown'?'incomplete':'failed');
};}
export function checkPipelineStage(config:PipelineStages,id:string,reason:'rollout-analysis'|'after-deploy'|'recovery'):PipelineStageFunction{return async scope=>{
  consume(scope,config);const desired=release(config);
  for(const [index,check] of config.stage.checks.entries()){
    const operationId=(config.recovery?'recovery-':'')+id+'-'+index,operation:PipelineOperation={id:operationId,kind:'check',status:'intent',releaseDigest:desired.digest};
    await intent(scope,config,operation);
    const request=readCheckRequest({invocationId:context(config,operationId).operationId,suiteId:check.suiteId,suiteDigest:check.suiteDigest,releaseId:desired.id,releaseDigest:desired.digest,stageId:config.stage.id,target:config.stage.target,reason});
    try{
      const result=readCheckResult(await config.checks.get(check.runnerId)!.run(request));
      if(result.checks.length>256||JSON.stringify(result).length>128*1024)throw Error('Pipeline check result exceeds receipt limits');
      if(canonical(result.request)!==canonical(request))throw Error('Check result identity differs');
      operation.check=result;operation.status=result.status==='passed'?'succeeded':'failed';
    }catch{operation.status='failed';}
    if(operation.status!=='succeeded')config.blocked=true;
    scope.setValue('operation:'+operationId,recordedOperation(operation));
    await progress(scope,config,operationId,operation.status==='succeeded'?'passed':'failed');
  }
};}
/** Final read still runs after confirmed failure, to retain the actual applied identity. Unknown writes remain blocked. */
export function observePipelineStage(config:PipelineStages):PipelineStageFunction{return async scope=>{
  consume(scope,config);if(!config.approved||config.uncertain)return;
  const desired=release(config),observation=await observe(scope,config,config.recovery?'recovery-after':'after');
  if(!observation?.known||observation.releaseDigest!==desired.digest)config.blocked=true;
};}
export function finishPipelineStage(config:PipelineStages):PipelineStageFunction{return async scope=>{
  consume(scope,config);const state=current(config);
  if(!config.approved){state.status='waiting';await progress(scope,config,'promotion-gate','passed');return;}
  if(config.uncertain)state.status='incomplete';
  else if(config.blocked)state.status='failed';
  else {state.status=config.recovery?'rolled-back':'passed';state.lastVerified=release(config).digest;}
  scope.setValue('outcome',{status:state.status,rollbackPolicy:config.stage.rollback,promotionAllowed:state.status==='passed',
    recovery:config.recovery?'attempted':state.status==='failed'?config.stage.rollback:'not-needed',unknownEffects:config.uncertain});
  await progress(scope,config,'outcome',state.status==='rolled-back'?'rolled-back':state.status==='passed'?'passed':state.status==='incomplete'?'incomplete':'failed');
};}
