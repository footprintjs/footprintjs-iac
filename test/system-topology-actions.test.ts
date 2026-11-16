import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSystemTopology } from '../src/system-topology/node.ts';
import { liveTopologyActions, projectSystemTopology, readSystemTopologyView } from '../src/system-topology/index.ts';
import type { AdapterFlowEvent } from '../src/adapter-flow/types.ts';
const graphDigest='a'.repeat(64), configurationDigest='b'.repeat(64);
const binding={deploymentRunId:'deployment-run',resourceId:'services',adapterId:'native',operationId:'operation'};
const definition=defineSystemTopology({id:'app',label:'App',boundaries:[],nodes:[
 {id:'api',label:'Backend',category:'compute',origin:'existing',bindings:{resourceIds:['services'],componentIds:['api-unit']}},
 {id:'tools',label:'Tools',category:'compute',origin:'existing',bindings:{resourceIds:['services'],componentIds:['tools-unit']}},
 {id:'database',label:'Database',category:'storage',origin:'existing',bindings:{resourceIds:['services'],checkIds:['database-readable']}},
],connections:[]},{targetId:'host',graphDigest});
const observations=()=>({...definition.binding,definitionDigest:definition.digest,configurationDigest,resources:[],components:[],checks:[]});
function event(sequence:number,values:Partial<AdapterFlowEvent>={}):AdapterFlowEvent{return{version:1,...binding,phase:'start',status:'running',runId:'native-run',logRunId:'native-run',runtimeStageId:'restart#1',subflowPath:['services','host'],drillPath:['services#1','host#1'],committedThroughIdx:0,stageName:'Restart service group',timestamp:sequence,sequence,...values};}
const capture=(events:readonly AdapterFlowEvent[])=>({version:1 as const,events,ignoredEvents:0,subscriberFailures:0});
const actions=(events:readonly AdapterFlowEvent[])=>liveTopologyActions({deploymentRunId:binding.deploymentRunId,nativeRunId:'native-run',bindings:[{adapterId:binding.adapterId,resourceId:binding.resourceId,operationId:binding.operationId}],capture:capture(events)});
test('real shared restart action remains shared, preserves Existing and cannot pretend database creation',()=>{
 const rows=actions([event(1)]),view=projectSystemTopology(definition,{...observations(),actions:rows});
 for(const node of view.nodes.slice(0,2)){assert.equal(node.originLabel,'Existing');assert.equal(node.actions?.[0]?.scope,'shared-resource');assert.equal(node.actions?.[0]?.label,'Restarting service group');assert.equal(node.actions?.[0]?.evidence.runtimeStageId,'restart#1');assert.equal(node.progress.completed,0);}
 assert.deepEqual(view.nodes[2]?.actions,[]);assert.equal(view.nodes[2]?.originLabel,'Existing');
 assert.deepEqual(readSystemTopologyView(JSON.parse(JSON.stringify(view))),view);
});
test('component actions keep sibling identities, repeated phases and parallel resources separate',()=>{
 const rows=actions([event(1),event(2,{phase:'observe',componentId:'api-unit',runtimeStageId:'api-observe#1'}),event(3,{phase:'observe',componentId:'tools-unit',runtimeStageId:'tools-observe#1'})]);
 const view=projectSystemTopology(definition,{...observations(),actions:rows});
 assert.equal(view.nodes[0]?.actions?.filter(row=>row.scope==='component').length,1);assert.equal(view.nodes[0]?.actions?.find(row=>row.scope==='component')?.label,'Checking component');
 assert.equal(view.nodes[1]?.actions?.find(row=>row.scope==='component')?.evidence.runtimeStageId,'tools-observe#1');
});
test('generic shared phases describe resource work without assuming a service-group adapter',()=>{
 for(const [phase,label] of [['inspect','Inspecting shared resource'],['configure','Updating shared configuration'],['reload','Reloading shared configuration'],['apply','Applying shared resource changes'],['observe','Checking shared resource']] as const){
  const view=projectSystemTopology(definition,{...observations(),actions:actions([event(1,{phase})])});
  assert.equal(view.nodes[0]?.actions?.[0]?.label,label);assert.equal(view.nodes[0]?.actions?.[0]?.scope,'shared-resource');
 }
});

test('observed completion remains provisional and does not increase verified progress or readiness',()=>{
 const rows=actions([event(1),event(2,{status:'passed'})]);assert.equal(rows.length,1);assert.equal(rows[0]?.status,'passed');assert.equal(rows[0]?.evidence.complete,false);
 const node=projectSystemTopology(definition,{...observations(),actions:rows}).nodes[0]!;assert.equal(node.progress.completed,0);assert.equal(node.facts.running,'unknown');
});
test('foreign deployment, operation, source run and lost capture are refused',()=>{
 for(const change of [{deploymentRunId:'foreign'},{operationId:'foreign'},{adapterId:'foreign'},{runId:'other-native'}])assert.throws(()=>actions([event(1),event(2,change)]));
 for(const key of ['ignoredEvents','subscriberFailures'])assert.throws(()=>liveTopologyActions({deploymentRunId:binding.deploymentRunId,nativeRunId:'native-run',bindings:[{adapterId:binding.adapterId,resourceId:binding.resourceId,operationId:binding.operationId}],capture:{...capture([event(1)]),[key]:1}}));
 assert.throws(()=>actions([event(2),event(1)]));
 let getters=0;const hostile={};Object.defineProperty(hostile,'events',{enumerable:true,get(){getters++;return[];}});
 assert.throws(()=>liveTopologyActions({deploymentRunId:binding.deploymentRunId,nativeRunId:'native-run',bindings:[],capture:hostile as any}));assert.equal(getters,0);
});
test('action reader refuses executable, duplicated, foreign-node and unscoped adapter facts',()=>{
 const rows=actions([event(1)]);const row=rows[0]!;
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:[{...row,label:'Made up'}]} as any));
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:[row,row]}));
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:[{...row,resourceId:'foreign'}]}));
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:[{...row,evidence:{...row.evidence,runtimeStageId:undefined}}]} as any));
});
test('new no-op observations contain only their actual verify actions, never historical restarts',()=>{
 const rows=actions([event(1,{phase:'observe',componentId:'api-unit',runtimeStageId:'verify#1',status:'passed'})]);
 const node=projectSystemTopology(definition,{...observations(),actions:rows}).nodes[0]!;assert.equal(node.actions?.length,1);assert.equal(node.actions?.[0]?.phase,'observe');
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { fingerprint } from '../src/util.ts';
import { createAdapterFlowChart } from '../src/adapter-flow/create-chart.ts';
import { createAdapterFlowRecorder } from '../src/adapter-flow/recorder.ts';
import { admitTopologyActions } from '../src/system-topology/node.ts';
import { admitAdapterFlowEvents } from '../src/adapter-flow/admission.ts';
import type { ResourceAdapter, Stack } from '../src/types.ts';

test('native action admission replays shared and component commits, never advisory observer order or historical runs',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-topology-actions-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const stack:Stack={name:'actions',resources:[{id:'services',provider:'native',spec:{release:'one'}}]};
 let applied=false,effects=0;const recorder=createAdapterFlowRecorder();
 const adapter:ResourceAdapter={name:'native',async observe(resource){return{exists:applied,owned:true,...applied?{fingerprint:fingerprint(resource.spec),ready:true}:{}};},async apply(){throw Error('opaque');},async remove(){},async waitReady(){},
  createApplyFlow(_resource,_context,binding){return createAdapterFlowChart(binding,[{id:'restart',name:'Restart service group',phase:'start',async run(){applied=true;effects++;}},
   {id:'observe-api',name:'Observe API',phase:'observe',componentId:'api-unit',async run(scope){scope.progress(binding,'observe','passed',{componentId:'api-unit',installed:true,running:true});}}]);},
  createVerifyFlow(_resource,_context,binding){return createAdapterFlowChart(binding,[{id:'verify-api',name:'Verify API',phase:'observe',componentId:'api-unit',async run(scope){scope.progress(binding,'observe','passed',{componentId:'api-unit',installed:true,running:true});}}]);},
 };
 const engine=new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],traceDirectory:join(directory,'trace')});
 const result=await engine.apply(stack);assert.equal(result.ok,true);const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));
 const proof={evidence,plan:result.plan,capture:recorder.getSnapshot()},rows=await admitTopologyActions(proof);
 assert.equal(effects,1);assert.ok(rows.every(row=>row.evidence.complete));assert.ok(rows.some(row=>row.phase==='start'&&row.status==='passed'&&!row.componentId));
 assert.ok(rows.some(row=>row.phase==='observe'&&row.componentId==='api-unit'&&row.evidence.runtimeStageId.includes('observe-api')));
 const observed=recorder.getEvents().find(row=>row.componentId==='api-unit'&&row.status==='running');assert.ok(observed,'real component running event exists before the measured callback');
 const componentRows=await admitAdapterFlowEvents({evidence,plan:result.plan,events:recorder.getEvents(),components:[{componentId:'api-unit',resourceId:'services'}]});
 assert.equal(componentRows[0]?.installed,true);assert.equal(componentRows[0]?.running,true,'wrapper completion preserves actual measured facts');
 const completeNode=projectSystemTopology(definition,{...observations(),components:componentRows.map(row=>({id:row.componentId,resourceId:row.resourceId,phase:row.phase,status:row.status,installed:row.installed,running:row.running,evidence:row.evidence})),actions:rows}).nodes[0]!;
 assert.equal(completeNode.status,'ready');assert.equal(completeNode.facts.running,'confirmed');assert.equal(completeNode.progress.completed,1);
 assert.deepEqual(await admitTopologyActions({...proof,capture:{...proof.capture,events:[]}}),rows,'retained native state wins over missing observer history');
 assert.deepEqual(await admitTopologyActions({...proof,capture:{...proof.capture,events:[...proof.capture.events].reverse().map((row,index)=>({...row,sequence:index+1}))}}),rows,'retained native state wins over observer reordering');
 await assert.rejects(()=>admitTopologyActions({...proof,plan:{...result.plan,operations:result.plan.operations.map(operation=>({...operation,resource:{...operation.resource,spec:{release:'foreign'}}}))}}),/operation-differs/);
 await assert.rejects(()=>admitTopologyActions({...proof,evidence:{...evidence,runId:'foreign'}}),/binding-differs/);
 const truncated=join(directory,'truncated.jsonl'),lines=(await readFile(result.tracePath!,'utf8')).trimEnd().split('\n');await writeFile(truncated,lines.slice(0,-1).join('\n')+'\n');
 await assert.rejects(()=>admitTopologyActions({...proof,evidence:{...evidence,tracePath:truncated,traceStatus:{...evidence.traceStatus,entries:lines.length-1}}}),/incomplete|differs/);
 const noop=await engine.apply(stack),noopEvidence=JSON.parse(await readFile(noop.evidencePath,'utf8'));
 const noopRows=await admitTopologyActions({evidence:noopEvidence,plan:noop.plan,capture:recorder.getSnapshot()});assert.equal(effects,1);assert.ok(noopRows.length);assert.ok(noopRows.every(row=>row.phase==='observe'));assert.ok(noopRows.every(row=>row.evidence.runId===noopEvidence.snapshot.runId));
});

test('failed provider action is retained as unconfirmed; later skipped actions are never invented',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-topology-failed-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const recorder=createAdapterFlowRecorder(),stack:Stack={name:'failed-actions',resources:[{id:'services',provider:'native',spec:{release:'one'}}]};
 const adapter:ResourceAdapter={name:'native',supportsSafeRetry:false,async observe(){return{exists:false};},async apply(){},async remove(){},async waitReady(){},createApplyFlow(_r,_c,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Provider effect',phase:'apply',async run(){throw Error('private');}},{id:'later',name:'Forbidden',phase:'start',async run(){throw Error('not reached');}}]);}};
 const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],traceDirectory:join(directory,'trace')}).apply(stack);assert.equal(result.ok,false);
 const evidence=JSON.parse(await readFile(result.evidencePath,'utf8')),rows=await admitTopologyActions({evidence,plan:result.plan,capture:recorder.getSnapshot()});
 assert.ok(rows.some(row=>row.phase==='apply'&&row.status==='unknown'));assert.ok(rows.every(row=>row.phase!=='start'));
});

test('mixed native action runs and stale component observations cannot lend readiness to a new action',()=>{
 const rows=actions([event(1)]),row=rows[0]!;
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:[row,{...row,phase:'observe',evidence:{...row.evidence,runId:'other-run'}}]}),/another component run/);
 assert.throws(()=>projectSystemTopology(definition,{...observations(),actions:rows,components:[{id:'api-unit',resourceId:'services',phase:'observe',status:'passed',installed:true,running:true,evidence:{kind:'adapter',runId:'stale-run',complete:true}}]}),/another component run/);
});

test('phase completion with no measured facts never borrows earlier installed or running values',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-topology-unmeasured-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const recorder=createAdapterFlowRecorder(),stack:Stack={name:'unmeasured',resources:[{id:'services',provider:'native',spec:{release:'one'}}]};let applied=false;
 const adapter:ResourceAdapter={name:'native',async observe(resource){return{exists:applied,owned:true,...applied?{fingerprint:fingerprint(resource.spec)}:{}};},async apply(){},async remove(){},async waitReady(){},createApplyFlow(_r,_c,binding){return createAdapterFlowChart(binding,[
  {id:'measured',name:'Measured observation',phase:'observe',componentId:'api-unit',async run(scope){applied=true;scope.progress(binding,'observe','passed',{componentId:'api-unit',installed:true,running:true});}},
  {id:'unmeasured',name:'Unmeasured boundary',phase:'observe',componentId:'api-unit',async run(){}},
 ]);}};
 const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],traceDirectory:join(directory,'trace')}).apply(stack);
 const evidence=JSON.parse(await readFile(result.evidencePath,'utf8')),rows=await admitAdapterFlowEvents({evidence,plan:result.plan,events:recorder.getEvents(),components:[{componentId:'api-unit',resourceId:'services'}]});
 assert.equal(rows[0]?.installed,undefined);assert.equal(rows[0]?.running,undefined);
 const node=projectSystemTopology(definition,{...observations(),components:rows.map(row=>({id:row.componentId,resourceId:row.resourceId,phase:row.phase,status:row.status,evidence:row.evidence}))}).nodes[0]!;
 assert.equal(node.facts.running,'unknown');assert.equal(node.progress.completed,0);
});

test('actual concurrent provider phases retain separate live action references',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-topology-parallel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const recorder=createAdapterFlowRecorder(),stack:Stack={name:'parallel-actions',resources:['one','two'].map(id=>({id,provider:'native',spec:{release:'one'}}))};
 const applied=new Set<string>();let entered=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const adapter:ResourceAdapter={name:'native',async observe(resource){return{exists:applied.has(resource.id),owned:true,...applied.has(resource.id)?{fingerprint:fingerprint(resource.spec)}:{}};},async apply(){},async remove(){},async waitReady(){},createApplyFlow(resource,_context,binding){return createAdapterFlowChart(binding,[{id:'actual-effect',name:'Actual provider effect',phase:'apply',componentId:resource.id,async run(){
  if(++entered===2){const events=recorder.getEvents(),current=events.at(-1)!;
   const bindings=events.map(event=>({adapterId:event.adapterId,resourceId:event.resourceId,operationId:event.operationId})).filter((row,index,all)=>all.findIndex(other=>other.resourceId===row.resourceId)===index);
   const rows=liveTopologyActions({deploymentRunId:current.deploymentRunId,nativeRunId:current.runId,bindings,capture:recorder.getSnapshot()});
   assert.equal(rows.filter(row=>row.status==='running').length,2);assert.equal(new Set(rows.map(row=>row.evidence.runtimeStageId)).size,2);release();
  }await barrier;applied.add(resource.id);
 }}]);}};
 const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],maxConcurrency:2,traceDirectory:join(directory,'trace')}).apply(stack);
 assert.equal(result.ok,true);assert.equal(entered,2);
});

test('explicit failed or unknown component observations are not overwritten by wrapper success',async t=>{
 for(const status of ['failed','unknown'] as const){
  const directory=await mkdtemp(join(tmpdir(),`iac-topology-${status}-`));t.after(()=>rm(directory,{recursive:true,force:true}));
  const recorder=createAdapterFlowRecorder(),stack:Stack={name:`explicit-${status}`,resources:[{id:'services',provider:'native',spec:{release:'one'}}]};let applied=false;
  const adapter:ResourceAdapter={name:'native',async observe(resource){return{exists:applied,owned:true,...applied?{fingerprint:fingerprint(resource.spec)}:{}};},async apply(){},async remove(){},async waitReady(){},createApplyFlow(_r,_c,binding){return createAdapterFlowChart(binding,[{id:'observe',name:'Actual component observation',phase:'observe',componentId:'api-unit',async run(scope){applied=true;scope.progress(binding,'observe',status,{componentId:'api-unit',installed:true,running:false});}}]);}};
  const result=await new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),recorders:[recorder],traceDirectory:join(directory,'trace')}).apply(stack);
  const evidence=JSON.parse(await readFile(result.evidencePath,'utf8')),rows=await admitAdapterFlowEvents({evidence,plan:result.plan,events:recorder.getEvents(),components:[{componentId:'api-unit',resourceId:'services'}]});
  assert.equal(rows[0]?.status,status);assert.equal(rows[0]?.running,false);
  const node=projectSystemTopology(definition,{...observations(),components:rows.map(row=>({id:row.componentId,resourceId:row.resourceId,phase:row.phase,status:row.status,installed:row.installed,running:row.running,evidence:row.evidence}))}).nodes[0]!;
  assert.equal(node.status,status==='failed'?'failed':'unknown');assert.equal(node.progress.completed,0);
 }
});
