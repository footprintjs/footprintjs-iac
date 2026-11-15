import { canonical,fingerprint } from '../util.ts';
import { readMigrationObservation,readMigrationReceipt,readMigrationRequest } from './data.ts';
import { applyReceipt,bindObservation,canRecover,revalidateCheckpoint } from './guards.ts';
import { recordedMigrationDefinition,recordedMigrationOperation,recordedMigrationState } from './summary.ts';
import type { MigrationScope } from './scope.ts';
import type { MigrationActionRequest,MigrationAdapter,MigrationObservation,MigrationOperation,MigrationPlan,MigrationRequest,MigrationState,MigrationStep } from './types.ts';
export const MIGRATION_EVENT='iac:migration-progress';
export interface MigrationStages {state:MigrationState;plan:MigrationPlan;adapter:MigrationAdapter;segment:'prepare'|'cutover'|'recovery';blocked:boolean;uncertain:boolean;last?:MigrationObservation;persist():Promise<void>;action(kind:'cutover'|'recover'|'inspect'):MigrationActionRequest;}
function consume(scope:MigrationScope,config:MigrationStages){if(scope.getValue('definitionDigest')!==config.state.definitionDigest||canonical(scope.getValue('definition'))!==canonical(recordedMigrationDefinition(config.state.definition,config.plan)))throw Error('Migration native binding differs');scope.getValue('summary');}
export function request(config:MigrationStages,step:MigrationRequest['step']):MigrationRequest{return readMigrationRequest({executionId:config.state.executionId!,operationId:fingerprint({executionId:config.state.executionId,id:step.id}),definitionDigest:config.state.definitionDigest,assessmentDigest:config.state.definition.assessmentDigest,migrationId:config.state.definition.id,step,source:config.state.definition.source,destination:config.state.definition.destination,checkpoint:structuredClone(config.state.checkpoint)});}
async function progress(scope:MigrationScope,config:MigrationStages,id:string,phase:MigrationRequest['step']['phase'],status:'running'|'passed'|'failed'|'incomplete'){
 scope.emitEvent(MIGRATION_EVENT,{executionId:config.state.executionId,stepId:id,phase,status});scope.setValue('summary',recordedMigrationState(config.state));try{await config.persist();}catch{throw Error('Migration durable intent or result could not be retained');}
}
export function initializeMigration(config:MigrationStages){return async(scope:MigrationScope)=>{scope.setValue('definition',recordedMigrationDefinition(config.state.definition,config.plan));scope.setValue('definitionDigest',config.state.definitionDigest);scope.setValue('executionId',config.state.executionId);scope.setValue('continuation',{segment:config.segment,previousRuns:config.state.recordings.map(receipt=>receipt.runId)});scope.setValue('summary',recordedMigrationState(config.state));};}
export function runDecision(config:MigrationStages,yes:string,no:string){return(scope:MigrationScope)=>{consume(scope,config);return config.blocked?no:yes;};}
export function skippedMigration(config:MigrationStages,id:string){return async(scope:MigrationScope)=>{consume(scope,config);scope.setValue('skipped:'+id,{reason:config.uncertain?'uncertain-outcome':'prior-failure'});};}
function observedFailure(config:MigrationStages,observation:MigrationObservation,phase:string){
 bindObservation(config.state.definition,observation);const checkpoint=config.state.checkpoint;
 if(phase==='quiesce'&&observation.fence){if(observation.fence.owner!==config.state.executionId)throw Error('Foreign write fence');checkpoint.fence=observation.fence;checkpoint.sourceSnapshot=observation.source.snapshot;}
 if(checkpoint.sourceSnapshot&&observation.source.snapshot!==checkpoint.sourceSnapshot||checkpoint.fence&&observation.fence&&canonical(checkpoint.fence)!==canonical(observation.fence))throw Error('Fenced source changed during a failed effect');
 if(phase==='cutover'&&observation.active==='destination')checkpoint.switched=true;
 if(observation.destination&&checkpoint.destination&&observation.destination.identity===checkpoint.destination.identity)checkpoint.destination=observation.destination;
}
export function migrationOperation(config:MigrationStages,step:MigrationStep|{id:string;phase:'recover-source'|'verify-recovery'|'resume-source';operation:string}){return async(scope:MigrationScope)=>{
 consume(scope,config);const input=request(config,{id:step.id,phase:step.phase,operation:step.operation}),operation:MigrationOperation={id:step.id,phase:step.phase,operation:step.operation,status:'intent',request:input};config.state.operations.push(operation);await progress(scope,config,step.id,step.phase,'running');
 try{
  const receipt=readMigrationReceipt(await config.adapter.execute(step,input));if(canonical(receipt.request)!==canonical(input))throw Error('Migration receipt does not match its issued request');
  bindObservation(config.state.definition,receipt.observation);
  if(receipt.status==='succeeded')applyReceipt(config.state.definition,config.state.checkpoint,step,receipt,config.state.executionId!);
  else if(receipt.status==='failed')observedFailure(config,receipt.observation,step.phase);
  operation.receipt=receipt;operation.status=receipt.status;config.last=receipt.observation;
 }catch{operation.status='unknown';}
 if(operation.status!=='succeeded'){config.blocked=true;config.uncertain=operation.status==='unknown';}
 scope.setValue('operation:'+step.id,recordedMigrationOperation(operation));await progress(scope,config,step.id,step.phase,operation.status==='succeeded'?'passed':operation.status==='failed'?'failed':'incomplete');
};}
export function revalidateMigration(config:MigrationStages,recovery=false){return async(scope:MigrationScope)=>{
 consume(scope,config);const id=recovery?'recovery-revalidation':'gate-revalidation',input=request(config,{id,phase:'revalidate',operation:'observe'}),operation:MigrationOperation={id,phase:'revalidate',operation:'observe',status:'intent',request:input};config.state.operations.push(operation);await progress(scope,config,id,'revalidate','running');
 try{const observation=readMigrationObservation(await config.adapter.observe(input));
  revalidateCheckpoint(config.state.definition,config.state.checkpoint,observation,config.state.executionId!,config.state.checkpoint.switched?'destination':'source');
  if(recovery&&!canRecover(config.state.checkpoint,observation,config.adapter.capabilities,config.state.definition,config.state.executionId!))throw Error('Recovery is not proven safe');
  if(!recovery&&(!config.state.checkpoint.verification?.passed||!config.state.checkpoint.backup||!config.state.checkpoint.destination))throw Error('Cutover data proof is incomplete');
  operation.observation=observation;operation.status='succeeded';config.last=observation;
 }catch{operation.status='unknown';config.blocked=true;config.uncertain=true;}
 scope.setValue('operation:'+id,recordedMigrationOperation(operation));await progress(scope,config,id,'revalidate',operation.status==='succeeded'?'passed':'incomplete');
};}
export function finishMigration(config:MigrationStages){return async(scope:MigrationScope)=>{
 consume(scope,config);const state=config.state;
 if(config.blocked){
  const recoverable=config.segment!=='recovery'&&!config.uncertain&&canRecover(state.checkpoint,config.last,config.adapter.capabilities,state.definition,state.executionId!);
  if(state.checkpoint.fence||config.uncertain){state.status='waiting';const kind=recoverable?'recover':'inspect';state.pendingAction={...config.action(kind),kind};}
  else state.status='failed';
  state.error=config.uncertain?'The provider outcome or saved checkpoint is uncertain. Inspect it before any further action.':'A protected migration stage did not pass. The original source and retained artifacts have not been deleted.';
 }else if(config.segment==='prepare'){state.status='waiting';state.pendingAction={...config.action('cutover'),kind:'cutover'};}
 else {state.status=config.segment==='recovery'?'recovered':'passed';delete state.error;}
 scope.setValue('outcome',{status:state.status,phase:config.segment,...(state.pendingAction?{action:state.pendingAction.kind}:{})});
 await progress(scope,config,'segment-outcome','revalidate',config.uncertain?'incomplete':config.blocked?'failed':'passed');
};}
