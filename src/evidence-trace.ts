import {lstat} from 'node:fs/promises';
import {readRecordFile} from 'footprintjs/sinks';
import {readStoredRecord,stateAt} from 'foottrace';
import type {RuntimeSnapshot} from 'footprintjs';
import {jsonCopy} from './graph/data.ts';
import {canonical} from './util.ts';

export interface EvidenceTraceInput {
  snapshot:RuntimeSnapshot;
  tracePath?:string;
  traceStatus?:{entries:number;failed:number;flushed:boolean;error?:string};
}
/** Verify a retained JSON evidence snapshot against its complete native file without running a provider. */
export async function verifyEvidenceTrace(input:EvidenceTraceInput):Promise<{runId:string;commits:number}> {
  const data=(key:keyof EvidenceTraceInput)=>{const field=Object.getOwnPropertyDescriptor(input,key);if(!field||!('value'in field))throw Error('Native trace evidence must contain data fields');return field.value;};
  const snapshot=jsonCopy(data('snapshot')) as unknown as RuntimeSnapshot,path=data('tracePath'),status=jsonCopy(data('traceStatus')) as unknown as EvidenceTraceInput['traceStatus'];
  if(typeof path!=='string'||!path||typeof snapshot.runId!=='string'||!snapshot.runId||snapshot.runId.length>256||!Array.isArray(snapshot.commitLog)||!snapshot.commitLog.length
    ||snapshot.commitLog.length>10000||!status||status.flushed!==true||status.failed!==0)throw Error('Native trace evidence is incomplete');
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)throw Error('Native trace exceeds file limits');
  const file=readRecordFile(path,{maxBytes:64*1024*1024});
  if(file.unreadable.length)throw Error('Native trace contains unreadable entries');
  if(!Number.isSafeInteger(status.entries)||status.entries!==file.entries.length)throw Error('Native trace entry count differs');
  const stored=readStoredRecord(file.entries),roots=[...stored.logs.keys()].filter(key=>JSON.parse(key).length===1),log=stored.root(snapshot.runId);
  if(roots.length!==1||!log?.complete||stored.unread.length||log.gaps.length||!log.commitLog.length
    ||canonical(log.commitLog)!==canonical(snapshot.commitLog)||canonical(stateAt(log,log.commitLog.length-1).state)!==canonical(snapshot.sharedState))throw Error('Native trace identity, replay or capture differs');
  return{runId:snapshot.runId,commits:log.commitLog.length};
}
