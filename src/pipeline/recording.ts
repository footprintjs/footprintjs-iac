import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { jsonCopy } from '../graph/data.ts';
import { canonical } from '../util.ts';

export interface PipelineRecordingIdentity {runId?:string;definitionDigest?:string;executionId?:string;stageId?:string}
/** Read-only native replay source. This never calls a provider, strategy or check runner. */
export async function loadPipelineRecording(path:string,expected:PipelineRecordingIdentity={}){
  const info=await stat(path);if(!info.isFile()||info.size>16*1024*1024)throw Error('Pipeline recording exceeds local limits');
  const value=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
  if(value.version!==1||value.kind!=='pipeline-native-evidence'||typeof value.runId!=='string'||!value.runId
    ||Object.entries(expected).some(([key,item])=>value[key]!==item)||!value.structure||typeof value.structure!=='object'
    ||value.tracePath!==resolve(path).replace(/\.json$/,'.jsonl')||!['passed','failed','incomplete'].includes(String(value.status)))throw Error('Pipeline recording differs from its expected execution');
  const snapshot=value.snapshot as {runId?:string;commitLog?:unknown;executionTree?:unknown;sharedState?:unknown}|undefined;
  if(!snapshot||snapshot.runId!==value.runId||!Array.isArray(snapshot.commitLog)||!snapshot.executionTree||!snapshot.sharedState)throw Error('Pipeline native run identity differs');
  const shared=snapshot.sharedState as {executionId?:string;definitionDigest?:string;definition?:{stageId?:string}};
  if(shared.executionId!==value.executionId||shared.definitionDigest!==value.definitionDigest||shared.definition?.stageId!==value.stageId)throw Error('Pipeline native scope identity differs');
  if(value.status!=='incomplete'){
    const traceStatus=value.traceStatus as {failed?:number;flushed?:boolean}|undefined;
    if(traceStatus?.failed!==0||traceStatus.flushed!==true)throw Error('Pipeline native trace is incomplete');
    const trace=await stat(String(value.tracePath));if(!trace.isFile()||trace.size>64*1024*1024)throw Error('Pipeline trace exceeds local limits');
    const replay=readStoredRecord(readRecordFile(String(value.tracePath)).entries).root(value.runId);
    if(!replay?.complete||replay.gaps.length||!replay.commitLog.length||canonical(stateAt(replay,replay.commitLog.length-1).state)!==canonical(snapshot.sharedState))throw Error('Pipeline native trace replay differs from its retained snapshot');
  }
  return {snapshot:jsonCopy(value.snapshot),structure:jsonCopy(value.structure),controlDeps:jsonCopy(value.controlDeps??{}),
    decisions:jsonCopy(value.decisions??[]),narrativeEntries:jsonCopy(value.narrative??[]),status:value.status,traceStatus:jsonCopy(value.traceStatus)};
}
