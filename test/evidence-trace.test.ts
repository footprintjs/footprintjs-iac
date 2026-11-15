import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {compileGraph} from '../src/graph/compile.ts';
import {checkConnections} from '../src/connections/run.ts';
import {verifyEvidenceTrace,type EvidenceTraceInput} from '../src/evidence.ts';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const directory=await mkdtemp(join(tmpdir(),'iac-native-read-'));t.after(()=>rm(directory,{recursive:true,force:true}));let calls=0;
  const graph=compileGraph({name:'native-read',resources:['app','store'].map(id=>({id,provider:'fixture',spec:{}})),boundaries:[],memberships:[],relations:[{from:'app',to:'store',kind:'communicatesWith'}]});
  const result=await checkConnections({graph,traceDirectory:directory,adapter:{async check(){calls++;return{method:'explicit-test',target:'local-fixture',observedAt:1,latencyMs:1,details:{}};}}});
  return{directory,result:JSON.parse(JSON.stringify(result)) as EvidenceTraceInput,calls:()=>calls};
}
test('public native trace verification replays the exact retained root without invoking probes',async t=>{
  const f=await fixture(t),before=f.calls(),verified=await verifyEvidenceTrace(f.result);
  assert.equal(verified.runId,f.result.snapshot.runId);assert.equal(verified.commits,f.result.snapshot.commitLog.length);assert.equal(f.calls(),before);
  const changed=structuredClone(f.result);changed.snapshot.sharedState.ok=false;await assert.rejects(()=>verifyEvidenceTrace(changed),/differs/);
});
test('native reader refuses missing, foreign, torn, unknown or oversized capture rather than trusting a flushed flag',async t=>{
  const f=await fixture(t),other=await fixture(t),path=f.result.tracePath!,original=await readFile(path);
  await assert.rejects(()=>verifyEvidenceTrace({...f.result,tracePath:undefined}));
  await assert.rejects(()=>verifyEvidenceTrace({...f.result,tracePath:other.result.tracePath}),/differs/);
  await writeFile(path,Buffer.concat([original,Buffer.from('{torn')]));await assert.rejects(()=>verifyEvidenceTrace(f.result),/unreadable/);
  await writeFile(path,Buffer.concat([original,Buffer.from('{"unknown":"entry"}\n')]));await assert.rejects(()=>verifyEvidenceTrace(f.result),/differs/);
  await writeFile(path,original);const wrong=structuredClone(f.result);wrong.snapshot.commitLog[0]!.stage='forged';await assert.rejects(()=>verifyEvidenceTrace(wrong),/differs/);
  const file=await open(path,'r+');try{await file.truncate(64*1024*1024+1);}finally{await file.close();}await assert.rejects(()=>verifyEvidenceTrace(f.result),/file limits/);
});
