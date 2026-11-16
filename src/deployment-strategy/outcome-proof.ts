import { lstat } from 'node:fs/promises';
import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { fingerprint } from '../util.ts';
import { sha } from './data.ts';
import type { SystemdOutcomeInspection } from './types.ts';

async function readNative(proof:SystemdOutcomeInspection['proof']){
  sha(proof.digest);const stat=await lstat(proof.evidencePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('systemd-outcome-proof-not-regular');
  const evidence=await loadEvidence(proof.evidencePath);
  if(evidence.runId!==proof.runId||evidence.snapshot.runId!==proof.runId||evidence.tracePath!==proof.tracePath||fingerprint(evidence)!==proof.digest)throw Error('systemd-outcome-proof-binding-differs');
  await verifyEvidenceTrace(evidence);return evidence;
}

/** Native completion contract over the registered inspector, independent of its package technology. */
export async function admitSystemdOutcomeProof(proof:SystemdOutcomeInspection['proof'],operationId:string):Promise<void>{
  if(!proof||Object.keys(proof).sort().join(',')!=='digest,evidencePath,runId,tracePath')throw Error('systemd-outcome-proof-required');
  const evidence=await readNative(proof),record=evidence as unknown as Record<string,unknown>;
  const shared=evidence.snapshot.sharedState,settlement=shared.settlement as {acknowledged?:boolean;operationId?:string;packageDigest?:string}|undefined;
  if(evidence.runId!==proof.runId||evidence.snapshot.runId!==proof.runId||evidence.tracePath!==proof.tracePath||fingerprint(evidence)!==proof.digest
    ||record.operationId!==operationId||record.status!=='verification-failed'||shared.outcome!=='verification-failed'
    ||settlement?.acknowledged!==true||settlement.operationId!==operationId)throw Error('systemd-outcome-not-acknowledged-failure');
  const related=record.relatedEvidence as (SystemdOutcomeInspection['proof']&{complete?:boolean})[]|undefined;
  if(!Array.isArray(related)||related.length<2||related.length>32)throw Error('systemd-original-runtime-proof-required');
  const activation=related.find(row=>row.evidencePath===record.originalEvidencePath),inspection=related.find(row=>row.evidencePath===record.inspectionEvidencePath);
  if(!activation||!inspection||activation.complete!==true||inspection.complete!==true
    ||activation.runId!==record.originalRunId||activation.digest!==record.originalRecordingDigest||activation.tracePath!==record.originalTracePath
    ||inspection.runId!==record.inspectionRunId||inspection.digest!==record.inspectionRecordingDigest||inspection.tracePath!==record.inspectionTracePath)throw Error('systemd-original-runtime-proof-binding-differs');
  const original=await readNative(activation),measured=await readNative(inspection),originalRecord=original as unknown as Record<string,unknown>,measuredRecord=measured as unknown as Record<string,unknown>;
  if(originalRecord.operationId!==operationId||original.snapshot.sharedState.runtimeActivated!==true
    ||originalRecord.definitionDigest!==record.definitionDigest||measuredRecord.operationId!==operationId
    ||measuredRecord.definitionDigest!==record.definitionDigest||measured.snapshot.sharedState.outcome!=='verification-failed')throw Error('systemd-runtime-control-not-confirmed');
  const originalObservation=original.snapshot.sharedState.observation as {ready?:boolean;packageDigest?:string|null;evidence?:{complete?:boolean}}|undefined;
  if(!['incomplete','verification-failed'].includes(String(originalRecord.status))
    ||originalRecord.status==='verification-failed'&&(original.snapshot.sharedState.outcome!=='verification-failed'||originalObservation?.evidence?.complete!==true
      ||originalObservation.ready!==false&&originalObservation.packageDigest===settlement?.packageDigest))throw Error('systemd-original-negative-outcome-not-confirmed');
  // Every referenced predecessor remains available and native; reopening performs no inspector call.
  for(const previous of related){if(previous!==activation&&previous!==inspection)await readNative(previous);}
}
