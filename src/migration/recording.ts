import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { jsonCopy } from '../graph/data.ts';
import { canonical } from '../util.ts';
export async function loadMigrationRecording(path:string,expected:{runId?:string;definitionDigest?:string;executionId?:string}={}){
 const info=await stat(path);if(!info.isFile()||info.size>16*1024*1024)throw Error('Migration evidence exceeds limits');const value=JSON.parse(await readFile(path,'utf8'));
 if(value.version!==1||value.kind!=='migration-native-evidence'||Object.entries(expected).some(([key,id])=>value[key]!==id)||value.snapshot?.runId!==value.runId||!value.snapshot?.executionTree||!Array.isArray(value.snapshot.commitLog)||!value.structure||value.tracePath!==resolve(path).replace(/\.json$/,'.jsonl')||!['passed','failed','incomplete'].includes(value.status))throw Error('Migration recording identity differs');
 const shared=value.snapshot.sharedState;if(shared?.executionId!==value.executionId||shared?.definitionDigest!==value.definitionDigest)throw Error('Migration native scope identity differs');
 if(value.status!=='incomplete'){
  const info=await stat(value.tracePath);if(!info.isFile()||info.size>64*1024*1024)throw Error('Migration trace exceeds limits');
  const stored=readStoredRecord(readRecordFile(value.tracePath).entries),log=stored.root(value.runId);
  if(!log?.complete||stored.unread.length||log.gaps.length||!log.commitLog.length||value.traceStatus?.failed!==0||!value.traceStatus?.flushed||canonical(stateAt(log,log.commitLog.length-1).state)!==canonical(shared))throw Error('Migration trace replay differs');
 }
 return {snapshot:jsonCopy(value.snapshot),structure:jsonCopy(value.structure),controlDeps:jsonCopy(value.controlDeps??{}),decisions:jsonCopy(value.decisions??[]),narrativeEntries:jsonCopy(value.narrative??[]),status:value.status};
}
