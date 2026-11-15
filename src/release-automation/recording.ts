import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readRecordFile} from 'footprintjs/sinks';
import {readStoredRecord,stateAt} from 'foottrace';
import {jsonCopy} from '../graph/data.ts';
import {canonical} from '../util.ts';

export async function loadReleaseAutomationRecording(path:string,expected:{runId?:string;definitionDigest?:string;attemptId?:string}={}){
  const info=await stat(path);if(!info.isFile()||info.size>32*1024*1024)throw Error('Bound automation recording');
  const value=JSON.parse(await readFile(path,'utf8'));
  if(value.version!==1||value.kind!=='release-automation-native-evidence'||value.tracePath!==resolve(path).replace(/\.json$/,'.jsonl')||Object.entries(expected).some(([key,id])=>value[key]!==id)
    ||value.snapshot?.runId!==value.runId||!Array.isArray(value.snapshot?.commitLog)||!value.snapshot.executionTree||!value.structure||typeof value.complete!=='boolean')throw Error('Automation native binding changed');
  if(value.complete){const info=await stat(value.tracePath);if(!info.isFile()||info.size>64*1024*1024)throw Error('Bound automation trace');
    const stored=readStoredRecord(readRecordFile(value.tracePath).entries),log=stored.root(value.runId);
    if(stored.unread.length||!log?.complete||log.gaps.length||!log.commitLog.length||value.traceStatus?.failed!==0||!value.traceStatus?.flushed||canonical(stateAt(log,log.commitLog.length-1).state)!==canonical(value.snapshot.sharedState))throw Error('Automation native replay changed');}
  return{complete:value.complete,snapshot:jsonCopy(value.snapshot),structure:jsonCopy(value.structure),controlDeps:jsonCopy(value.controlDeps??{}),narrativeEntries:jsonCopy(value.narrative??[])};
}
