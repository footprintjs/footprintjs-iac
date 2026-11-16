import {lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadEvidence} from '../evidence.ts';
import {verifyEvidenceTrace} from '../evidence-trace.ts';
import {canonical,fingerprint} from '../util.ts';
import type {PackageActivationState,PackageNativeRecording,PackageReconciliationSegment} from './types.ts';

export async function loadPackageReconciliationProof(proof:PackageNativeRecording,directory:string){
 if(!proof.complete||dirname(resolve(proof.evidencePath))!==directory||dirname(resolve(proof.tracePath))!==directory)throw Error('package-reconciliation-capture-not-admitted');
 const stat=await lstat(proof.evidencePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('package-reconciliation-capture-not-admitted');
 const e=await loadEvidence(proof.evidencePath);if(e.runId!==proof.runId||e.snapshot.runId!==proof.runId||e.tracePath!==proof.tracePath||fingerprint(e)!==proof.digest)throw Error('package-reconciliation-capture-binding-differs');await verifyEvidenceTrace(e);return e;
}
export function packageReconciliationBinding(state:PackageActivationState,segment:PackageReconciliationSegment){return{definitionDigest:state.definitionDigest,operationId:state.operationId,originalRunId:state.recording!.runId,originalRecordingDigest:state.recording!.digest,reconciliationId:segment.id,reconciliationConfigurationDigest:segment.configurationDigest,previousRecordingDigest:segment.previousRecordingDigest};}
export function packageReconciliationRelatedEvidence(state:PackageActivationState,segment:PackageReconciliationSegment,settlement:boolean){
 const rows=state.reconciliations??[],index=rows.findIndex(s=>s.id===segment.id),prior=(index>=0?rows[index-1]:rows.at(-1))?.recording;
 return[{kind:'package-activation',...state.recording!},...(settlement?[{kind:'package-reconciliation-observation',...segment.observationRecording}]:[]),...(prior?[{kind:'package-reconciliation-previous',...prior}]:[])];
}
export async function admitPackageReconciliationObservation(state:PackageActivationState,segment:PackageReconciliationSegment,directory:string){
 const e=await loadPackageReconciliationProof(segment.observationRecording,directory),v=e as unknown as Record<string,unknown>,binding=packageReconciliationBinding(state,segment);
 if(v.kind!=='package-reconciliation-observation'||Object.entries(binding).some(([k,x])=>canonical(v[k])!==canonical(x))||canonical(e.snapshot.sharedState.binding)!==canonical(binding)||canonical(e.snapshot.sharedState.receipt)!==canonical(state.receipt)||canonical(e.snapshot.sharedState.target)!==canonical(segment.target)||canonical(e.snapshot.sharedState.observation)!==canonical(segment.observation)||canonical(v.relatedEvidence)!==canonical(packageReconciliationRelatedEvidence(state,segment,false)))throw Error('package-reconciliation-observation-differs');
 const outcome=e.snapshot.sharedState.outcome??'incomplete';if(v.status!==outcome)throw Error('package-reconciliation-observation-status-differs');
 if(['ready','verification-failed'].includes(String(outcome))){const target=segment.target,receipt=state.receipt!,observation=segment.observation;
  const expectedPending=state.reconciliationBase?.status==='verification-failed'?null:receipt.operationId;
  if(!target||target.id!==state.definition.targetId||target.identityDigest!==receipt.identityDigest||target.currentDigest!==receipt.packageDigest||target.pendingOperationId!==expectedPending||!observation?.evidence.complete||outcome!==(observation.ready&&observation.packageDigest===receipt.packageDigest?'ready':'verification-failed'))throw Error('package-reconciliation-measurement-not-confirmed');
 }
 return e;
}
export async function admitPackageReconciliationChain(state:PackageActivationState,directory:string){
 let previous:string|null=null,observation=state.reconciliationBase?.observation;
 for(const [index,segment] of (state.reconciliations??[]).entries()){
  if(segment.originalRunId!==state.recording!.runId||segment.originalRecordingDigest!==state.recording!.digest||segment.previousRecordingDigest!==previous)throw Error('package-reconciliation-chain-differs');
  if(!segment.observationRecording.complete){if(index!==state.reconciliations!.length-1||state.status!=='incomplete'||state.reconciliationIntent?.id!==segment.id||segment.status!=='incomplete')throw Error('package-reconciliation-capture-incomplete');continue;}
  const measured=await admitPackageReconciliationObservation(state,segment,directory),expected=segment.observation?.evidence.complete?(segment.observation.ready&&segment.observation.packageDigest===state.definition.packageDigest?'ready':'verification-failed'):'incomplete';
  if(segment.observation)observation=segment.observation;
  if(segment.settlementRecording){
   if(!segment.settlementRecording.complete){if(index!==state.reconciliations!.length-1||state.status!=='incomplete'||state.reconciliationIntent?.id!==segment.id||segment.status!=='incomplete')throw Error('package-reconciliation-settlement-capture-incomplete');continue;}
   const e=await loadPackageReconciliationProof(segment.settlementRecording,directory),v=e as unknown as Record<string,unknown>,binding={...packageReconciliationBinding(state,segment),inspectionRunId:segment.observationRecording.runId,inspectionRecordingDigest:segment.observationRecording.digest};
   if(v.kind!=='package-reconciliation-settlement'||Object.entries(binding).some(([k,x])=>canonical(v[k])!==canonical(x))||canonical(e.snapshot.sharedState.binding)!==canonical(binding)||canonical(e.snapshot.sharedState.receipt)!==canonical(state.receipt)||v.originalEvidencePath!==state.recording!.evidencePath||v.originalTracePath!==state.recording!.tracePath||v.inspectionEvidencePath!==segment.observationRecording.evidencePath||v.inspectionTracePath!==segment.observationRecording.tracePath||canonical(v.relatedEvidence)!==canonical(packageReconciliationRelatedEvidence(state,segment,true)))throw Error('package-reconciliation-settlement-differs');
   if(['ready','verification-failed'].includes(segment.status)&&(!segment.observation?.evidence.complete||measured.snapshot.sharedState.outcome!==expected||v.status!==expected||e.snapshot.sharedState.outcome!==expected||canonical(e.snapshot.sharedState.settlement)!==canonical({acknowledged:true,operationId:state.operationId,packageDigest:state.definition.packageDigest})||segment.status!==expected))throw Error('package-reconciliation-outcome-not-confirmed');
  }else if(segment.status!=='incomplete')throw Error('package-reconciliation-settlement-missing');
  const latest=segment.settlementRecording??segment.observationRecording;if(canonical(segment.recording)!==canonical(latest))throw Error('package-reconciliation-proof-alias-differs');previous=latest.digest;
 }
 if(canonical(state.observation)!==canonical(observation))throw Error('package-reconciliation-latest-observation-differs');
 const last=state.reconciliations?.at(-1);if(['ready','verification-failed'].includes(state.status)&&(!last||last.status!==state.status||state.reconciliationIntent))throw Error('package-reconciliation-current-status-differs');
}
