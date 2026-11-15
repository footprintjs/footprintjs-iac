import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readRecordFile} from 'footprintjs/sinks';
import {readStoredRecord,stateAt} from 'foottrace';
import {jsonCopy} from '../graph/data.ts';
import {canonical} from '../util.ts';

export async function loadChangeAssessmentRecording(path:string,expected:{runId?:string;executionId?:string;definitionDigest?:string}={}){
  const info=await stat(path);if(!info.isFile()||info.size>8*1024*1024)throw Error('Assessment recording exceeds local limits');
  const value=JSON.parse(await readFile(path,'utf8'));
  if(value.version!==1||value.kind!=='change-assessment-native-evidence'||value.tracePath!==resolve(path).replace(/\.json$/,'.jsonl')
    ||Object.entries(expected).some(([key,id])=>value[key]!==id)||typeof value.runId!=='string'||value.snapshot?.runId!==value.runId||!value.structure||!Array.isArray(value.snapshot?.commitLog))throw Error('Assessment native recording identity changed');
  const shared=value.snapshot.sharedState;
  if(shared?.definitionDigest!==value.definitionDigest||shared?.executionId!==value.executionId)throw Error('Assessment native scope binding changed');
  if(value.complete){const trace=await stat(value.tracePath);if(!trace.isFile()||trace.size>16*1024*1024)throw Error('Assessment trace exceeds local limits');
    const stored=readStoredRecord(readRecordFile(value.tracePath).entries),record=stored.root(value.runId);
    if(!record?.complete||record.gaps.length||stored.unread.length||!record.commitLog.length||value.traceStatus?.failed!==0||value.traceStatus?.flushed!==true
      ||canonical(stateAt(record,record.commitLog.length-1).state)!==canonical(shared))throw Error('Assessment native replay is incomplete or changed');
  }
  return{complete:value.complete===true,snapshot:jsonCopy(value.snapshot),structure:jsonCopy(value.structure),controlDeps:jsonCopy(value.controlDeps??{}),narrativeEntries:jsonCopy(value.narrative??[])};
}
