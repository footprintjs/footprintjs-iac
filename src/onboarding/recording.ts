import {lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadEvidence} from '../evidence.ts';
import {verifyEvidenceTrace} from '../evidence-trace.ts';
import {canonical,fingerprint} from '../util.ts';
import {jsonCopy} from '../graph/data.ts';
import type {OnboardingEntry} from './state.ts';
export async function admitOnboardingRecording(entry:OnboardingEntry,directory:string,bindingDigest:string){
 const proof=entry.proof;if(!proof||!entry.after||dirname(resolve(proof.evidencePath))!==directory||dirname(resolve(proof.tracePath))!==directory)throw Error('Onboarding recording is not bound');
 const info=await lstat(proof.evidencePath);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Bound onboarding recording');
 const evidence=await loadEvidence(proof.evidencePath),value=evidence as unknown as Record<string,unknown>;
 if(value.kind!=='onboarding-native-evidence'||value.bindingDigest!==bindingDigest||value.operationId!==entry.id||value.runId!==proof.runId||value.tracePath!==proof.tracePath||fingerprint(evidence)!==proof.digest)throw Error('Onboarding recording binding differs');
 await verifyEvidenceTrace(evidence);const shared=evidence.snapshot.sharedState;
 if(shared.bindingDigest!==bindingDigest||shared.operationId!==entry.id||canonical(shared.action)!==canonical(entry.action)||canonical(shared.before)!==canonical(entry.before)||canonical(shared.after)!==canonical(entry.after)||shared.recordingComplete!==true)throw Error('Onboarding outcome differs from native evidence');
 return {snapshot:jsonCopy(evidence.snapshot),structure:jsonCopy(evidence.structure),controlDeps:jsonCopy(evidence.controlDeps),narrativeEntries:jsonCopy(evidence.narrative)};
}
