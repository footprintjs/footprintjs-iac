import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { fingerprint } from '../src/util.ts';
import { createAdapterFlowChart } from '../src/adapter-flow/create-chart.ts';
import { createAdapterFlowRecorder } from '../src/adapter-flow/recorder.ts';
import { admitAdapterFlowEvents } from '../src/adapter-flow/admission.ts';
import type { ResourceAdapter, Stack } from '../src/types.ts';

const stack: Stack = { name:'native-adapter', resources:[{id:'app',provider:'native',spec:{release:'one'}}] };
test('adapter subflow shares the native parent run, follows durable intent, and is absent on no-op', async t => {
  const directory=await mkdtemp(join(tmpdir(),'iac-native-adapter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new FileStateStore(join(directory,'state')), recorder=createAdapterFlowRecorder();
  let applied=false,effects=0;
  const adapter:ResourceAdapter={name:'native',supportsSafeRetry:false,
    async observe(resource){return {exists:applied,owned:true,...(applied?{fingerprint:fingerprint(resource.spec),ready:true}:{})};},
    async apply(){throw Error('opaque callback must not run');},async remove(){},async waitReady(){},
    createApplyFlow(resource,_context,binding){return createAdapterFlowChart(binding,[{id:'real-effect',name:'Real effect',phase:'apply',async run(scope){
      assert.equal((await store.load(stack.name)).resources.app?.pending?.operationId,binding.operationId);
      effects++;applied=true;scope.progress(binding,'observe','passed',{componentId:'runtime',installed:true,running:true});
    }}]);},
  };
  const engine=new InfraEngine({adapters:[adapter],store,recorders:[recorder],traceDirectory:join(directory,'trace')});
  const result=await engine.apply(stack);assert.equal(result.ok,true);assert.equal(effects,1);
  const events=recorder.getEvents();assert.ok(events.length>=3);assert.ok(events.every(event=>event.deploymentRunId===result.runId&&event.subflowPath.length>=2));
  const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));
  assert.ok(events.every(event=>event.runId===evidence.snapshot.runId));
  assert.ok(events.filter(event=>event.componentId).every(event=>evidence.controlDeps[event.runtimeStageId]),'native child stage decisions retain their governing control evidence');
  assert.match(JSON.stringify(evidence.structure),/real-effect/);
  const proof={evidence,plan:result.plan,events,components:[{componentId:'runtime',resourceId:'app'}]};
  const admitted=await admitAdapterFlowEvents(proof);assert.equal(admitted.length,1);assert.equal(admitted[0]?.running,true);assert.equal(admitted[0]?.evidence.complete,true);
  await assert.rejects(()=>admitAdapterFlowEvents({...proof,events:events.map(event=>({...event,deploymentRunId:'foreign'}))}),/run-differs/);
  await assert.rejects(()=>admitAdapterFlowEvents({...proof,events:events.map(event=>event.componentId?{...event,running:false}:event)}),/write-missing/);
  await assert.rejects(()=>admitAdapterFlowEvents({...proof,events:events.map(event=>event.componentId?{...event,runtimeStageId:'foreign-stage'}:event)}),/write-missing/);
  // Reopening uses retained JSON data and native storage only; no provider is called.
  const retained=JSON.parse(JSON.stringify(proof));assert.deepEqual(await admitAdapterFlowEvents(retained),admitted);assert.equal(effects,1);
  const truncated=join(directory,'truncated.jsonl'),lines=(await readFile(result.tracePath!,'utf8')).trimEnd().split('\n');await writeFile(truncated,lines.slice(0,-1).join('\n')+'\n');
  await assert.rejects(()=>admitAdapterFlowEvents({...proof,evidence:{...evidence,tracePath:truncated,traceStatus:{...evidence.traceStatus,entries:lines.length-1}}}),/incomplete|differs/);
  const before=events.length;assert.equal((await engine.apply(stack)).ok,true);assert.equal(effects,1);assert.equal(recorder.getEvents().length,0);
  assert.ok(before>0);
});

test('uncertain unsafe native effect retains intent, emits no ready, hides transport errors and blocks reopening',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-native-unknown-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new FileStateStore(join(directory,'state'));let effects=0;
  const adapter:ResourceAdapter={name:'native',supportsSafeRetry:false,async observe(){return{exists:false};},async apply(){throw Error('legacy');},async remove(){},async waitReady(){},
    createApplyFlow(_resource,_context,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Effect',phase:'apply',async run(){effects++;throw Error('PRIVATE_TOKEN');}},
      {id:'after',name:'Forbidden later effect',phase:'start',async run(){throw Error('should skip');}}]);}};
  const engine=new InfraEngine({adapters:[adapter],store,traceDirectory:join(directory,'trace')});
  const result=await engine.apply(stack);assert.equal(result.ok,false);assert.equal(effects,1);
  assert.ok((await store.load(stack.name)).resources.app?.pending);
  const evidence=await readFile(result.evidencePath,'utf8');assert.equal(evidence.includes('PRIVATE_TOKEN'),false);
  assert.equal((await readFile(result.tracePath!,'utf8')).includes('PRIVATE_TOKEN'),false);
  assert.equal(evidence.includes('"status":"ready"'),false);
  await assert.rejects(()=>engine.apply(stack),/unsafe pending effect/);assert.equal(effects,1);
});

test('native capture setup loss stops before a provider effect and cannot report Ready',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-native-no-capture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const blocker=join(directory,'blocked');await writeFile(blocker,'retain');let effects=0;
  const adapter:ResourceAdapter={name:'native',async observe(){return{exists:false};},async apply(){effects++;},async remove(){},async waitReady(){},
    createApplyFlow(_r,_c,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Effect',phase:'apply',async run(){effects++;}}]);}};
  const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),traceDirectory:blocker}).apply(stack);
  assert.equal(result.ok,false);assert.equal(effects,0);assert.equal(result.traceStatus?.flushed,false);assert.match(result.failure?.message??'',/incomplete/);
});

test('native file order wins over omitted or reordered observer history',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-native-terminal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let applied=false;const recorder=createAdapterFlowRecorder();
  const adapter:ResourceAdapter={name:'native',async observe(resource){return{exists:applied,owned:true,...(applied?{fingerprint:fingerprint(resource.spec)}:{})};},async apply(){},async remove(){},async waitReady(){},
    createApplyFlow(_r,_c,binding){return createAdapterFlowChart(binding,[
      {id:'first',name:'First measured state',phase:'observe',async run(scope){applied=true;scope.progress(binding,'observe','passed',{componentId:'runtime',installed:true,running:true});}},
      {id:'last',name:'Later measured state',phase:'observe',async run(scope){scope.progress(binding,'observe','passed',{componentId:'runtime',installed:true,running:false});}},
    ]);}};
  const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),traceDirectory:join(directory,'trace'),recorders:[recorder]}).apply(stack);
  const evidence=JSON.parse(await readFile(result.evidencePath,'utf8')),events=recorder.getEvents(),proof={evidence,plan:result.plan,events,components:[{componentId:'runtime',resourceId:'app'}]};
  assert.equal((await admitAdapterFlowEvents(proof))[0]?.running,false);
  const older=events.find(event=>event.componentId&&event.running===true)!;
  assert.equal((await admitAdapterFlowEvents({...proof,events:[older]}))[0]?.running,false);
  assert.equal((await admitAdapterFlowEvents({...proof,events:[...events].reverse().map((event,index)=>({...event,sequence:index+1}))}))[0]?.running,false);
  assert.equal((await admitAdapterFlowEvents({...proof,events:[]}))[0]?.running,false);
});

test('native parallel siblings overlap, publish their own results and settle before dependent skips',{timeout:60_000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-native-parallel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const applied=new Set<string>();let inflight=0,maxInflight=0;
  const entered=new Set<string>();let releaseBoth!:()=>void;
  const bothEntered=new Promise<void>(resolve=>{releaseBoth=resolve;});
  const adapter:ResourceAdapter={name:'native',supportsSafeRetry:false,async observe(resource){return{exists:applied.has(resource.id),owned:true,...(applied.has(resource.id)?{fingerprint:fingerprint(resource.spec)}:{})};},async apply(){},async remove(){},async waitReady(){},
    createApplyFlow(resource,_context,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Provider effect',phase:'apply',async run(){
      assert.ok(resource.id==='a'||resource.id==='b','dependent work cannot enter the failed batch');
      inflight++;maxInflight=Math.max(maxInflight,inflight);entered.add(resource.id);
      // Provider A cannot settle before B enters, irrespective of scheduler or disk latency.
      if(entered.size===2)releaseBoth();await bothEntered;
      inflight--;if(resource.id==='b')throw Error('private');applied.add(resource.id);
    }}]);}};
  const parallel:Stack={name:'parallel-native',resources:[{id:'a',provider:'native',spec:{x:1}},{id:'b',provider:'native',spec:{x:1}},{id:'after',provider:'native',dependsOn:['a'],spec:{x:1}}]};
  const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),maxConcurrency:2,traceDirectory:join(directory,'trace')}).apply(parallel);
  assert.equal(result.ok,false);assert.equal(maxInflight,2);assert.equal(result.failure?.resourceId,'b');assert.deepEqual([...applied],['a']);
  assert.equal((result.results.a as {status:string}).status,'complete');assert.equal((result.results.b as {status:string}).status,'failed');assert.equal((result.results.after as {status:string}).status,'skipped');
});
