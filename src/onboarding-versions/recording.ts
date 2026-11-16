import {lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadEvidence} from '../evidence.ts';
import {verifyEvidenceTrace} from '../evidence-trace.ts';
import {jsonCopy} from '../graph/data.ts';
import {fingerprint,canonical} from '../util.ts';
import type {RegistryEntry} from './state.ts';
export async function admitVersionRecording(entry:RegistryEntry,directory:string,bindingDigest:string){const proof=entry.proof;if(!proof||dirname(resolve(proof.evidencePath))!==directory||dirname(resolve(proof.tracePath))!==directory)throw Error('Configuration recording left its registry');const info=await lstat(proof.evidencePath);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Bound configuration evidence');const evidence=await loadEvidence(proof.evidencePath),value=evidence as unknown as Record<string,unknown>;if(value.kind!=='onboarding-version-native-evidence'||value.bindingDigest!==bindingDigest||value.operationId!==entry.id||evidence.runId!==proof.runId||fingerprint(evidence)!==proof.digest||value.tracePath!==proof.tracePath)throw Error('Configuration evidence identity differs');await verifyEvidenceTrace(evidence);const shared=evidence.snapshot.sharedState;const measured=shared.observations as {observation?:unknown}|undefined;if(canonical(measured?.observation)!==canonical(entry.observation))throw Error('Configuration observation differs from native capture');
 if(shared.operationId!==entry.id||shared.head!==entry.head||shared.fromVersionId!==entry.fromVersionId||shared.recordingComplete!==true||canonical(shared.action)!==canonical(entry.action)||canonical(shared.review)!==canonical(entry.review)||shared.reviewSeal!==entry.reviewSeal||shared.outcome!==entry.outcome||canonical(shared.proposal)!==canonical(entry.proposal??null)||canonical(shared.reconciles)!==canonical(entry.reconciles??[]))throw Error('Configuration ledger differs from native recording');
 return{snapshot:jsonCopy(evidence.snapshot),structure:jsonCopy(evidence.structure),controlDeps:jsonCopy(evidence.controlDeps),narrativeEntries:jsonCopy(evidence.narrative)};
}
