import { canonical } from '../util.ts';
import type { MigrationDefinition,MigrationObservation,MigrationCheckpoint,MigrationReceipt,MigrationStep } from './types.ts';
export function bindObservation(definition:MigrationDefinition,observation:MigrationObservation){
 if(!observation.sourceRetained)throw Error('Original source must remain retained');
 if(observation.source.id!==definition.source.id||observation.source.scope!==definition.source.scope||observation.source.identity!==definition.source.identity
   ||observation.destination&&(observation.destination.id!==definition.destination.id||observation.destination.scope!==definition.destination.scope||observation.destination.identity===definition.source.identity))throw Error('Observed migration resource identity differs');
}
export function revalidateCheckpoint(definition:MigrationDefinition,checkpoint:MigrationCheckpoint,observation:MigrationObservation,executionId:string,active:'source'|'destination',destinationStable=true){
 bindObservation(definition,observation);
 if(observation.active!==active||observation.source.snapshot!==checkpoint.sourceSnapshot||!checkpoint.fence||checkpoint.fence.owner!==executionId||canonical(observation.fence)!==canonical(checkpoint.fence)
   ||checkpoint.backup&&(checkpoint.backup.sourceSnapshot!==checkpoint.sourceSnapshot||canonical(observation.backup)!==canonical(checkpoint.backup))
   ||checkpoint.destination&&(!observation.destination||observation.destination.identity!==checkpoint.destination.identity||destinationStable&&observation.destination.snapshot!==checkpoint.destination.snapshot))throw Error('Migration snapshot, fence, backup or destination changed');
}
export function canRecover(checkpoint:MigrationCheckpoint,observation:MigrationObservation|undefined,capabilities:readonly string[],definition:MigrationDefinition,executionId:string):boolean{
 if(!observation||!capabilities.includes('verify-recovery')||!capabilities.includes('resume-source')||!observation.sourceRetained)return false;
 try{revalidateCheckpoint(definition,checkpoint,observation,executionId,checkpoint.switched?'destination':'source');}catch{return false;}
 return !checkpoint.switched||capabilities.includes('recover-source')&&observation.writesAfterCutover==='none'&&observation.rollbackCompatible;
}
export function applyReceipt(definition:MigrationDefinition,checkpoint:MigrationCheckpoint,step:MigrationStep|{phase:string},receipt:MigrationReceipt,executionId:string){
 const observation=receipt.observation;bindObservation(definition,observation);
 if(step.phase==='inspect'){
  if(observation.active!=='source'||observation.fence!==null||observation.destination)throw Error('Migration must start from its unfenced original with no replacement');return;
 }
 if(step.phase==='quiesce'){
  if(observation.active!=='source'||!observation.fence||observation.fence.owner!==executionId||!observation.sourceRetained)throw Error('Source writes were not fenced');
  checkpoint.sourceSnapshot=observation.source.snapshot;checkpoint.fence=observation.fence;return;
 }
 const resuming=step.phase==='resume'||step.phase==='resume-source',active=step.phase==='cutover'||step.phase==='verify-consumer'||step.phase==='retain'||step.phase==='resume'?'destination':'source';
 if(!resuming)revalidateCheckpoint(definition,checkpoint,observation,executionId,active,step.phase!=='transfer'&&step.phase!=='create');
 else {
  bindObservation(definition,observation);
  if(observation.active!==active||observation.fence!==null||active==='destination'&&observation.source.snapshot!==checkpoint.sourceSnapshot||!observation.sourceRetained
   ||checkpoint.backup&&(checkpoint.backup.sourceSnapshot!==checkpoint.sourceSnapshot||canonical(observation.backup)!==canonical(checkpoint.backup))||checkpoint.destination&&observation.destination?.identity!==checkpoint.destination.identity)throw Error('Writes did not resume on the verified retained system');
 }
 if(step.phase==='backup'){
  if(!receipt.backup||receipt.backup.sourceSnapshot!==checkpoint.sourceSnapshot||canonical(receipt.backup)!==canonical(observation.backup))throw Error('Backup receipt does not match measured backup');checkpoint.backup=receipt.backup;
 }else if(step.phase==='create'){
  if(!observation.destination)throw Error('Replacement was not created');checkpoint.destination=observation.destination;
 }else if(step.phase==='transfer'){
  if(!observation.destination||!checkpoint.destination||observation.destination.identity!==checkpoint.destination.identity)throw Error('Transfer destination changed');checkpoint.destination=observation.destination;
 }else if(step.phase==='verify-data'){
  const proof=receipt.verification;if(!proof?.passed||proof.sourceSnapshot!==checkpoint.sourceSnapshot||proof.destinationSnapshot!==checkpoint.destination?.snapshot)throw Error('Data verification did not prove the fenced source and replacement');checkpoint.verification=proof;
 }else if(step.phase==='cutover')checkpoint.switched=true;
 else if(step.phase==='recover-source')checkpoint.switched=false;
 else if(step.phase==='verify-consumer'||step.phase==='verify-recovery'){
  const expected=step.phase==='verify-recovery'?definition.source.identity:checkpoint.destination?.identity;
  if(!receipt.consumer?.passed||receipt.consumer.activeIdentity!==expected)throw Error('Consumer check did not verify the active system');checkpoint.consumerVerified=true;
 }else if(step.phase==='retain'){
  if(!observation.sourceRetained)throw Error('Original source was not retained');checkpoint.retained=true;
 }else if(resuming)checkpoint.writesResumed=true;
}
