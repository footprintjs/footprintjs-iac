import {lstat} from 'node:fs/promises';
import type {RuntimeSnapshot} from 'footprintjs';
import {loadEvidence} from '../evidence.ts';
import {verifyEvidenceTrace} from '../evidence-trace.ts';

/** Native JSONL/snapshot admission is read-only and never invokes source/build adapters. */
export async function loadSourcePreparationRecording(path:string,expected:{runId?:string;definitionDigest?:string;executionId?:string;tracePath?:string;status?:string}={}){
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw Error('Source preparation recording exceeds local limits');
 const evidence=await loadEvidence(path),value=evidence as unknown as Record<string,unknown>;
 if(value.kind!=='source-preparation-native-evidence'||Object.entries(expected).some(([key,v])=>value[key]!==v)||evidence.snapshot.runId!==evidence.runId||evidence.snapshot.sharedState.executionId!==value.executionId)throw Error('Source preparation native recording binding differs');
 await verifyEvidenceTrace(evidence);
 return {snapshot:evidence.snapshot as RuntimeSnapshot,structure:evidence.structure,controlDeps:evidence.controlDeps,narrativeEntries:evidence.narrative};
}
