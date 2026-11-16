import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InfraEngine} from '../src/engine.ts';
import {FileStateStore} from '../src/store.ts';
import {compileGraph} from '../src/graph/compile.ts';
import {fingerprint} from '../src/util.ts';
import {createAdapterFlowChart} from '../src/adapter-flow/create-chart.ts';
import {createDeploymentRecorder} from '../src/progress/recorder.ts';
import {admitDeploymentProgress,type DeploymentProgressAdmissionInput} from '../src/progress/node.ts';
import type {ResourceAdapter} from '../src/types.ts';

async function fixture(t:test.TestContext,native=true,fail=false,slowParallel=false){
 const directory=await mkdtemp(join(tmpdir(),'iac-progress-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const stored=new Map<string,string>(),recorder=createDeploymentRecorder(),calls={apply:0,observe:0};
 let markAStarted!:()=>void,markBFinished!:()=>void;const aStarted=new Promise<void>(resolve=>{markAStarted=resolve;}),bFinished=new Promise<void>(resolve=>{markBFinished=resolve;});
 if(slowParallel)recorder.subscribe(event=>{if(event.resourceId==='a'&&event.status==='deploying')markAStarted();if(event.resourceId==='b'&&event.status==='ready')markBFinished();});
 const adapter:ResourceAdapter={name:'registered',supportsSafeRetry:false,async observe(resource){calls.observe++;return{exists:stored.has(resource.id),owned:true,...(stored.has(resource.id)?{fingerprint:stored.get(resource.id),ready:true}:{})};},async apply(resource){calls.apply++;if(slowParallel&&resource.id==='a')await bFinished;if(slowParallel&&resource.id==='b')await aStarted;if(fail)throw Error('private provider failure');stored.set(resource.id,fingerprint(resource.spec));},async remove(){},async waitReady(){}};
 if(native)adapter.createApplyFlow=(resource,context,binding)=>createAdapterFlowChart(binding,[{id:'provider-change',name:'Run provider change',phase:'apply',async run(){await adapter.apply(resource,context);}}]);
 const graph=compileGraph({name:'progress-proof',boundaries:[],memberships:[],relations:[],resources:[{id:'a',provider:adapter.name,spec:{release:'one'}},{id:'b',provider:adapter.name,spec:{release:'one'}},{id:'c',provider:adapter.name,spec:{release:'one'},dependsOn:['a','b']}]});
 const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],chartObservers:[recorder],maxConcurrency:2,traceDirectory:join(directory,'trace')}).apply(graph);
 const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));
 const input:DeploymentProgressAdmissionInput={evidence,graph,plan:result.plan,runId:result.runId,ok:result.ok,chart:recorder.getSnapshot().chart!,recorder:recorder.getSnapshot()};
 return{directory,input,calls,result};
}
test('complete native child progress reopens with exact mounted start/result stages and no provider work',async t=>{
 const f=await fixture(t),before={...f.calls},view=await admitDeploymentProgress(f.input);
 assert(view.resources.every(row=>row.status==='ready'));assert.equal(view.events.length,9);assert.equal(view.progressCapture.source,'native-recorder');
 assert(view.events.some(row=>row.runtimeStageId.startsWith('execute-a/native-begin#')));assert(view.events.some(row=>row.runtimeStageId.startsWith('execute-a/native-result#')));
 assert.deepEqual(await admitDeploymentProgress(JSON.parse(JSON.stringify(f.input))),view);assert.deepEqual(f.calls,before);
});
test('legacy root callbacks preserve coalesced recorder starts; commit fallback never invents timestamps or starts',async t=>{
 const f=await fixture(t,false),recorded=await admitDeploymentProgress(f.input),fallback=await admitDeploymentProgress({...f.input,recorder:undefined});
 assert.equal(recorded.events.length,9);assert.equal(fallback.events.length,6);assert.equal(fallback.progressCapture.observedStarts,false);assert(fallback.events.every(row=>row.timestamp===undefined&&row.status!=='deploying'));assert.deepEqual(fallback.resources.map(row=>row.status),['ready','ready','ready']);
});
test('omitted starts, omitted terminals, stale/foreign identities and altered facts cannot replace complete native progress',async t=>{
 const f=await fixture(t);for(const change of [
  (v:any)=>{v.events=v.events.filter((row:any)=>row.status!=='deploying');},
  (v:any)=>{v.events.pop();},
  (v:any)=>{v.events[3].runtimeStageId='foreign-stage';},
  (v:any)=>{v.events[3].runId='foreign-run';},
  (v:any)=>{v.events[3].action='delete';},
  (v:any)=>{v.events[3].status='ready';},
  (v:any)=>{v.resources.a.status='failed';},
  (v:any)=>{v.ignoredEvents=1;},
 ]){const recorder=structuredClone(f.input.recorder)as any;change(recorder);recorder.events.forEach((row:any,index:number)=>row.sequence=index+1);recorder.sequence=recorder.events.length;await assert.rejects(()=>admitDeploymentProgress({...f.input,recorder}),/native-progress/);}
 const altered=structuredClone(f.input.plan);altered.operations[0]!.operationId='f'.repeat(64);await assert.rejects(()=>admitDeploymentProgress({...f.input,plan:altered}),/native-progress/);
 await assert.rejects(()=>admitDeploymentProgress({...f.input,runId:'foreign'}),/native-progress/);
});
test('genuine failed native units and skipped dependents never become a successful projection',async t=>{
 const f=await fixture(t,true,true),view=await admitDeploymentProgress(f.input);assert(view.resources.some(row=>row.status==='failed'));assert.equal(view.resources.find(row=>row.id==='c')?.status,'skipped');
 await assert.rejects(()=>admitDeploymentProgress({...f.input,ok:true}),/native-progress/);
});
test('truncated child capture is refused before any old ready event can be reused',async t=>{
 const f=await fixture(t),path=join(f.directory,'truncated.jsonl'),lines=(await readFile(f.input.evidence.tracePath!,'utf8')).trimEnd().split('\n');await writeFile(path,lines.slice(0,-1).join('\n')+'\n');
 await assert.rejects(()=>admitDeploymentProgress({...f.input,evidence:{...f.input.evidence,tracePath:path,traceStatus:{...f.input.evidence.traceStatus!,entries:lines.length-1}}}));
});

test('legacy parallel starts may precede another resource terminal commit without losing their true overlap',async t=>{
 const f=await fixture(t,false,false,true),view=await admitDeploymentProgress(f.input);
 const aStart=view.events.findIndex(row=>row.resourceId==='a'&&row.status==='deploying'),bFinish=view.events.findIndex(row=>row.resourceId==='b'&&row.status==='ready'),aFinish=view.events.findIndex(row=>row.resourceId==='a'&&row.status==='ready');
 assert(aStart<bFinish&&bFinish<aFinish);assert(view.resources.every(row=>row.status==='ready'));
});
test('reordered native child histories cannot invent another execution order while retaining genuine terminal facts',async t=>{
 const f=await fixture(t),recorder=structuredClone(f.input.recorder)as any,original=recorder.events;
 recorder.events=[...original.filter((row:any)=>row.status==='pending'),...['b','a','c'].flatMap(id=>original.filter((row:any)=>row.resourceId===id&&row.status!=='pending'))];
 recorder.events.forEach((row:any,index:number)=>row.sequence=index+1);recorder.resources=Object.fromEntries(['a','b','c'].map(id=>[id,recorder.events.findLast((row:any)=>row.resourceId===id)]));
 await assert.rejects(()=>admitDeploymentProgress({...f.input,recorder}),/native-progress/);
});

test('legacy commit fallback still rejects a changed execute mapping even when its stage exists',async t=>{
 const f=await fixture(t,false),chart=structuredClone(f.input.chart!);Object.assign(chart.resources[0]!,{executeStageId:'load-desired'});
 await assert.rejects(()=>admitDeploymentProgress({...f.input,evidence:{...f.input.evidence,deploymentChart:undefined},chart,recorder:undefined}),/native-progress/);
});

test('every saved native chart mapping remains bound to its immutable capture, including unused gate metadata',async t=>{
 const f=await fixture(t);for(const field of ['gateStageId','skipStageId','joinStageId']as const){const chart=structuredClone(f.input.chart!);Object.assign(chart.resources[0]!,{[field]:'load-desired'});await assert.rejects(()=>admitDeploymentProgress({...f.input,chart,recorder:undefined}),/native-progress|deployment/);}
});
