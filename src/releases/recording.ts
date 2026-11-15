import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { jsonCopy } from '../graph/data.ts';
import { canonical } from '../util.ts';

/** Read-only native replay admission. No build or provider adapter can be invoked here. */
export async function loadReleaseBuildRecording(evidencePath:string,tracePath:string,expected:{runId:string;executionId:string;definitionDigest:string}){
  if(resolve(evidencePath).replace(/\.json$/,'.jsonl')!==resolve(tracePath))throw Error('Release trace left its native evidence binding');
  for(const path of [evidencePath,tracePath]){const info=await stat(path);if(!info.isFile()||info.size>8*1024*1024)throw Error('Release recording exceeds local limits');}
  const value=JSON.parse(await readFile(evidencePath,'utf8'));
  if(value.version!==1||value.kind!=='release-build-native-evidence'||value.tracePath!==tracePath
    ||Object.entries(expected).some(([key,id])=>value[key]!==id)||value.snapshot?.runId!==expected.runId||!Array.isArray(value.snapshot?.commitLog)
    ||!value.snapshot.executionTree||!value.structure)throw Error('Release recording differs from expected execution');
  if(value.status==='passed'){
    const record=readStoredRecord(readRecordFile(tracePath).entries).root(expected.runId);
    if(!record?.complete||record.gaps.length||!record.commitLog.length||value.traceStatus?.failed!==0||value.traceStatus?.flushed!==true
      ||canonical(stateAt(record,record.commitLog.length-1).state)!==canonical(value.snapshot.sharedState))throw Error('Release native recording is incomplete or changed');
  }
  return{status:value.status,snapshot:jsonCopy(value.snapshot),structure:jsonCopy(value.structure),
    controlDeps:jsonCopy(value.controlDeps??{}),narrativeEntries:jsonCopy(value.narrative??[])};
}
