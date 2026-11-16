import {lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadEvidence} from '../evidence.ts';
import {verifyEvidenceTrace} from '../evidence-trace.ts';
import {canonical,fingerprint} from '../util.ts';
import type {PackageActivationState} from './types.ts';
import {admitPackageReconciliationChain} from './reconciliation-recording.ts';
import {readPackageActivationState} from './data.ts';

const settlements=new WeakSet<object>();
export function packageSettlementProof(state:PackageActivationState){
 if(!state.recording?.complete||!['ready','verification-failed'].includes(state.status))throw Error('package-native-settlement-not-admitted');
 const proof=Object.freeze({runId:state.recording.runId,digest:state.recording.digest,outcome:state.status as 'ready'|'verification-failed'});settlements.add(proof);return proof;
}
export const isPackageSettlementProof=(value:object)=>settlements.has(value);
export function packageReconciliationSettlementProof(proof:{runId:string;digest:string},outcome:'ready'|'verification-failed',previousSettlement?:{runId:string;digest:string;outcome:'verification-failed'}){
 const value=Object.freeze({...proof,outcome,...previousSettlement?{previousSettlement}:{}});settlements.add(value);return value;
}

export async function admitPackageActivationRecording(input:PackageActivationState,directory:string){
 const state=readPackageActivationState(input);
 const proof=state.recording;if(!proof?.complete)throw Error('package-native-capture-incomplete');
 if(dirname(resolve(proof.evidencePath))!==directory||dirname(resolve(proof.tracePath))!==directory)throw Error('package-native-capture-path-differs');
 const info=await lstat(proof.evidencePath);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('package-native-capture-not-admitted');
 const evidence=await loadEvidence(proof.evidencePath),value=evidence as unknown as Record<string,unknown>;
 if(value.kind!=='package-activation-native-evidence'||value.definitionDigest!==state.definitionDigest||value.operationId!==state.operationId||evidence.runId!==proof.runId||evidence.snapshot.runId!==proof.runId||evidence.tracePath!==proof.tracePath||fingerprint(evidence)!==proof.digest)throw Error('package-native-capture-binding-differs');
 await verifyEvidenceTrace(evidence);
 const shared=evidence.snapshot.sharedState,progress=evidence.snapshot.recorders?.filter(r=>r.id==='iac-package-runtime-progress');
 if(canonical(shared.definition)!==canonical(state.definition)||shared.operationId!==state.operationId||progress?.length!==1||canonical((progress[0]!.data as {events?:unknown}).events)!==canonical(state.events))throw Error('package-native-capture-progress-differs');
 for(const key of ['before','staged','receipt','observation'] as const){const expected=key==='observation'&&state.reconciliationBase?state.reconciliationBase.observation:state[key];if(canonical(shared[key])!==canonical(expected))throw Error('package-native-receipt-differs');}
 if(state.reconciliationBase){
  const origin=state.reconciliationBase.status??'incomplete';
  if(value.status!==origin||shared.runtimeActivated!==true||!state.receipt||canonical(shared.receipt)!==canonical(state.receipt)||origin==='verification-failed'&&(shared.outcome!=='verification-failed'||!state.reconciliationBase.observation?.evidence.complete))throw Error('package-reconciliation-original-activation-not-acknowledged');
  await admitPackageReconciliationChain(state,directory);
 }else{
  if(['ready','verification-failed','failed'].includes(state.status)&&value.status!==state.status)throw Error('package-native-outcome-differs');
  if(['ready','verification-failed'].includes(state.status)&&shared.outcome!==state.status)throw Error('package-native-outcome-differs');
 }
 return evidence;
}
