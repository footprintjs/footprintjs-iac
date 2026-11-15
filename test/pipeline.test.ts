import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { defineReleaseManifest } from '../src/releases/node.ts';
import { PipelineWorkflow,FilePipelineStore,FilePipelineTargetStore,loadPipelineRecording,directStrategy,canaryStrategy,blueGreenStrategy,compileRolloutPlans,type PipelineDefinition,type PipelineRegistry,type RolloutAdapter,type PipelineState } from '../src/pipeline/node.ts';
import type { CheckRunner } from '../src/checks/types.ts';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const directory=await mkdtemp(join(tmpdir(),'iac-pipeline-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const manifest=(version:number)=>defineReleaseManifest({id:'v'+version,source:{repository:'https://github.com/example/app.git',ref:'v'+version,commit:String(version).repeat(40),tree:'a'.repeat(40)},recipe:{id:'images',digest:'b'.repeat(64)},artifacts:[{id:'app',digest:String(version).repeat(64),reference:'registry/app:v'+version}]});
  const v1=manifest(1),v2=manifest(2),targetStore=new FilePipelineTargetStore(join(directory,'targets'));
  const deployed=new Map<string,string>(),calls:{operation:string;stageId:string;release:string;operationId:string}[]=[];
  const controls:{failedStage?:string;unknown?:boolean;failOperation?:string;failedRecovery?:boolean;gate?:Promise<void>;entered?:()=>void;drift?:boolean}={};
  let currentStore:FilePipelineStore|undefined;
  const adapter:RolloutAdapter={id:'host-a',label:'First host',capabilities:['deploy','deploy-candidate','set-traffic','promote-candidate','restore','prepare-environment','switch-traffic','promote-environment'],
    async execute(action,release,context){
      const state=await currentStore?.load(),target=await targetStore.load(context.target);
      assert.equal(state?.stages.find(stage=>stage.id===context.stageId)?.operations.at(-1)?.status,'intent');
      assert.equal(target.pending?.operationId,context.operationId);
      calls.push({operation:action.operation,stageId:context.stageId,release:release.digest,operationId:context.operationId});
      controls.entered?.();if(controls.gate)await controls.gate;
      if(controls.unknown)throw Error('SECRET-DO-NOT-RECORD');
      if(['deploy','promote-candidate','switch-traffic','restore'].includes(action.operation))deployed.set(context.target.scope,release.digest);
      return {status:controls.failOperation===action.operation?'failed':'succeeded',changes:[{resourceId:'application',action:'update'}],metadata:{secret:'SECRET-DO-NOT-RECORD'}};
    },
    async observe(context){return {known:true,releaseDigest:controls.drift?'f'.repeat(64):deployed.get(context.target.scope)??null};}};
  const runner:CheckRunner={id:'check-a',suites:()=>[{id:'access',label:'Login and access',digest:'c'.repeat(64),kind:'contract'}],async run(request){
    const passed=request.reason==='recovery'?!controls.failedRecovery:request.stageId!==controls.failedStage;
    return {request,status:passed?'passed':'failed',checks:[{id:'login-access',status:passed?'passed':'failed'}]};}};
  const registry:PipelineRegistry={strategies:[directStrategy(),canaryStrategy(),blueGreenStrategy()],adapters:[adapter],checks:[runner]};
  const definition=(stages=['dev']):PipelineDefinition=>({version:1,id:'release-app',label:'Application release',configurationDigest:'d'.repeat(64),stages:stages.map(id=>({id,label:id,target:{id:'app-'+id,scope:'local/'+id},strategyId:'direct',adapterId:'host-a',checks:[{runnerId:'check-a',suiteId:'access',suiteDigest:'c'.repeat(64)}],rollback:'disabled',promotion:'automatic'}))});
  function workflow(name:string,release=v2,config=definition(),registryInput=registry){const store=new FilePipelineStore(join(directory,name));currentStore=store;return {store,workflow:new PipelineWorkflow({definition:config,release,registry:registryInput,store,targetStore})};}
  return {directory,v1,v2,targetStore,deployed,calls,controls,adapter,runner,registry,definition,workflow};
}

test('same immutable release crosses arbitrary named stages; native trace replays fully, redacts private metadata and reopens without effects',async t=>{
  const f=await fixture(t),definition=f.definition(['development','gamma','production']),run=f.workflow('run',f.v2,definition),seen:PipelineState[]=[];
  run.workflow.subscribe(state=>seen.push(state));const result=await run.workflow.start();assert.equal(result.status,'passed');
  assert.deepEqual(f.calls.map(call=>call.stageId),['development','gamma','production']);
  assert.ok(f.calls.every(call=>call.release===f.v2.digest));assert.equal(new Set(f.calls.map(call=>call.operationId)).size,3);
  assert.ok(seen.some(state=>state.stages[0]?.operations.at(-1)?.status==='intent'));
  for(const receipt of result.recordings){
    const loaded=await loadPipelineRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:result.definitionDigest,executionId:result.executionId!,stageId:receipt.stageId});
    const snapshot=loaded.snapshot as {sharedState:unknown};
    const record=readStoredRecord(readRecordFile(receipt.tracePath).entries),log=record.root(receipt.runId)!;
    assert.equal(log.complete,true);assert.deepEqual(log.gaps,[]);assert.deepEqual(stateAt(log,log.commitLog.length-1).state,snapshot.sharedState);
    assert.ok((loaded.decisions as unknown[]).length>0);
    for(const path of [receipt.evidencePath,receipt.tracePath])assert.equal((await readFile(path,'utf8')).includes('SECRET-DO-NOT-RECORD'),false);
  }
  assert.deepEqual(await run.workflow.snapshot(),result);assert.deepEqual(await run.workflow.start(),result);assert.equal(f.calls.length,3);
  const latest=await f.targetStore.load(definition.stages[2]!.target);assert.equal(latest.lastApplied?.digest,f.v2.digest);assert.equal(latest.lastVerified?.release.digest,f.v2.digest);
  const tampered=structuredClone(result);tampered.stages[0]!.operations[1]!.receipt!.changes![0]!.action='create';await writeFile(run.store.path,JSON.stringify(tampered));
  await assert.rejects(()=>run.workflow.snapshot(),/differ/);
});

test('unsupported strategy operations and changed suite identity fail before all effects',async t=>{
  const f=await fixture(t),definition=f.definition();definition.stages[0]!.strategyId='canary';
  const limited={...f.adapter,capabilities:['deploy']};
  assert.throws(()=>f.workflow('unsupported',f.v2,definition,{...f.registry,adapters:[limited]}),/support/);
  const stale=f.definition();stale.stages[0]!.checks[0]!.suiteDigest='f'.repeat(64);
  assert.throws(()=>f.workflow('stale-suite',f.v2,stale),/suite/);assert.equal(f.calls.length,0);
});

test('canary executes real weight operations interleaved with acceptance checks; second adapter and custom strategy require no core changes',async t=>{
  const f=await fixture(t),definition=f.definition();definition.stages[0]!.strategyId='canary';definition.stages[0]!.parameters={weights:[10,40,100]};
  const run=f.workflow('canary',f.v2,definition),result=await run.workflow.start();assert.equal(result.status,'passed');
  assert.deepEqual(f.calls.map(call=>call.operation),['deploy-candidate','set-traffic','set-traffic','set-traffic','promote-candidate']);
  assert.equal(result.stages[0]!.operations.filter(op=>op.kind==='check').length,4);
  const second:RolloutAdapter={id:'host-b',label:'Independent tool',capabilities:['custom-apply'],async execute(_action,release,context){f.deployed.set(context.target.scope,release.digest);return {status:'succeeded'};},observe:f.adapter.observe};
  const custom=f.definition(['custom']);custom.stages[0]!.adapterId='host-b';custom.stages[0]!.strategyId='custom';
  const registry={...f.registry,strategies:[...f.registry.strategies,{id:'custom',label:'Custom strategy',plan:()=>({steps:[{kind:'action' as const,id:'apply',operation:'custom-apply'}]})}],adapters:[...f.registry.adapters,second]};
  assert.equal(compileRolloutPlans(custom,f.v2,registry)[0]!.plan.steps[0]!.id,'apply');
  assert.equal((await f.workflow('custom',f.v2,custom,registry).workflow.start()).status,'passed');
});

test('rollback disabled stops promotion and preserves distinct applied and verified releases',async t=>{
  const f=await fixture(t),definition=f.definition(['dev','gamma']);
  assert.equal((await f.workflow('baseline',f.v1,definition).workflow.start()).status,'passed');
  f.calls.length=0;f.controls.failedStage='dev';const run=f.workflow('bad-dev',f.v2,definition),result=await run.workflow.start();
  assert.equal(result.status,'failed');assert.equal(result.stages[1]!.status,'pending');assert.deepEqual(f.calls.map(call=>call.operation),['deploy']);
  const state=await f.targetStore.load(definition.stages[0]!.target);assert.equal(state.lastApplied?.digest,f.v2.digest);assert.equal(state.lastVerified?.release.digest,f.v1.digest);
  await assert.rejects(()=>run.workflow.start(),/already started/);assert.equal(f.calls.length,1);
});

test('automatic recovery restores only a verified baseline, checks recovery, and never promotes failed candidate',async t=>{
  const f=await fixture(t),definition=f.definition(['gamma','prod']);await f.workflow('baseline',f.v1,definition).workflow.start();
  definition.stages[0]!.rollback='automatic';f.controls.failedStage='gamma';f.calls.length=0;
  const run=f.workflow('recover',f.v2,definition),result=await run.workflow.start();
  assert.equal(result.status,'failed');assert.equal(result.stages[0]!.status,'rolled-back');assert.equal(result.stages[1]!.status,'pending');
  assert.deepEqual(f.calls.map(call=>[call.operation,call.release]),[['deploy',f.v2.digest],['restore',f.v1.digest]]);
  assert.ok(result.stages[0]!.operations.some(op=>op.check?.request.reason==='recovery'&&op.check.status==='passed'));
  assert.deepEqual(result.recordings.map(item=>[item.kind,item.status]),[['rollout','failed'],['recovery','passed']]);
  assert.equal((await f.targetStore.load(definition.stages[0]!.target)).lastVerified!.release.digest,f.v1.digest);
  assert.deepEqual(await run.workflow.snapshot(),result);
});

test('manual promotion and recovery are explicit bound durable continuations, not repeated rollout effects',async t=>{
  const f=await fixture(t),definition=f.definition(['gamma']);await f.workflow('baseline',f.v1,definition).workflow.start();
  definition.stages[0]!.promotion='manual';definition.stages[0]!.rollback='manual';f.calls.length=0;f.controls.failedStage='gamma';
  const run=f.workflow('manual',f.v2,definition),waiting=await run.workflow.start();
  assert.equal(waiting.pendingAction?.kind,'promote');assert.equal(f.calls.length,0);assert.equal(waiting.stages[0]!.status,'waiting');
  await assert.rejects(()=>run.workflow.promote({stageId:'gamma',releaseDigest:f.v2.digest,token:'wrong'}),/pending action/);
  const request=waiting.pendingAction!,{kind:_,...promote}=request,recovery=await run.workflow.promote(promote);
  assert.equal(recovery.pendingAction?.kind,'recover');assert.equal(recovery.stages[0]!.status,'failed');assert.equal(f.calls.length,1);
  assert.deepEqual(await run.workflow.snapshot(),recovery);
  const {kind:__,...recover}=recovery.pendingAction!,done=await run.workflow.recover(recover);
  assert.equal(done.status,'failed');assert.equal(done.stages[0]!.status,'rolled-back');assert.deepEqual(f.calls.map(call=>call.operation),['deploy','restore']);
  await assert.rejects(()=>run.workflow.recover(recover),/pending action/);assert.deepEqual(await run.workflow.snapshot(),done);
});

test('unknown provider effects stay incomplete, retain target intent and prevent automatic retry or recovery',async t=>{
  const f=await fixture(t),definition=f.definition();await f.workflow('baseline',f.v1,definition).workflow.start();
  f.controls.unknown=true;definition.stages[0]!.rollback='automatic';f.calls.length=0;const run=f.workflow('unknown',f.v2,definition),result=await run.workflow.start();
  assert.equal(result.status,'incomplete');assert.equal(result.stages[0]!.status,'incomplete');assert.deepEqual(f.calls.map(call=>call.operation),['deploy']);
  assert.ok((await f.targetStore.load(definition.stages[0]!.target)).pending);
  await assert.rejects(()=>run.workflow.start(),/already started/);
  f.controls.unknown=false;const next=await f.workflow('new-attempt',f.v2,definition).workflow.start();assert.equal(next.status,'incomplete');assert.equal(f.calls.length,1);
});

test('shared local target lock rejects overlap while unrelated targets may proceed',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void;
  f.controls.gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});f.controls.entered=entered;
  const first=f.workflow('first'),running=first.workflow.start();await started;
  const second=f.workflow('second'),blocked=await second.workflow.start();assert.equal(blocked.status,'incomplete');assert.equal(f.calls.length,1);
  let unrelatedEntered!:()=>void;const unrelatedStarted=new Promise<void>(resolve=>{unrelatedEntered=resolve;});f.controls.entered=unrelatedEntered;
  const unrelated=f.workflow('unrelated',f.v2,f.definition(['other'])),parallel=unrelated.workflow.start();await unrelatedStarted;assert.equal(f.calls.length,2);
  release();assert.equal((await running).status,'passed');assert.equal((await parallel).status,'passed');assert.equal(f.calls.length,2);
});

test('missing verified baseline and observed drift fail safely without release writes',async t=>{
  const f=await fixture(t),definition=f.definition();definition.stages[0]!.rollback='automatic';
  const noBaseline=await f.workflow('no-baseline',f.v2,definition).workflow.start();assert.equal(noBaseline.status,'failed');assert.equal(f.calls.length,0);
  definition.stages[0]!.rollback='disabled';await f.workflow('baseline',f.v1,definition).workflow.start();f.calls.length=0;f.controls.drift=true;
  const drift=await f.workflow('drift',f.v2,definition).workflow.start();assert.equal(drift.status,'incomplete');assert.equal(f.calls.length,0);
});

test('verified baseline from another target is rejected even when its release digest matches',async t=>{
  const f=await fixture(t),baseline=await f.workflow('baseline',f.v1,f.definition(['dev'])).workflow.start();assert.equal(baseline.status,'passed');
  const source=await f.targetStore.load(f.definition(['dev']).stages[0]!.target),target=f.definition(['gamma']).stages[0]!.target;
  await f.targetStore.save({version:1,kind:'pipeline-target',target,lastApplied:f.v1,lastVerified:source.lastVerified});
  f.calls.length=0;const definition=f.definition(['gamma']);definition.stages[0]!.rollback='automatic';
  const result=await f.workflow('forged-target',f.v2,definition).workflow.start();assert.equal(result.status,'incomplete');assert.equal(f.calls.length,0);
});

test('native evidence snapshot edits cannot be replayed as an authentic result',async t=>{
  const f=await fixture(t),run=f.workflow('native-tamper'),state=await run.workflow.start(),receipt=state.recordings[0]!;
  const evidence=JSON.parse(await readFile(receipt.evidencePath,'utf8'));evidence.snapshot.sharedState.stage.lastApplied='e'.repeat(64);
  await writeFile(receipt.evidencePath,JSON.stringify(evidence));
  await assert.rejects(()=>loadPipelineRecording(receipt.evidencePath),/replay differs/);await assert.rejects(()=>run.workflow.snapshot(),/replay differs/);
});

test('terminal status cannot bypass missing receipts and changed manifests cannot start',async t=>{
  const f=await fixture(t),run=f.workflow('forged-pass'),state=structuredClone(await run.workflow.snapshot());await run.store.save(state);
  state.status='passed';state.executionId='forged';state.stages[0]!.status='passed';state.stages[0]!.lastApplied=f.v2.digest;state.stages[0]!.lastVerified=f.v2.digest;
  await writeFile(run.store.path,JSON.stringify(state));await assert.rejects(()=>run.workflow.start(),/Invalid release pipeline/);assert.equal(f.calls.length,0);
  const altered=structuredClone(f.v2);altered.artifacts[0]!.digest='f'.repeat(64);assert.throws(()=>f.workflow('changed-release',altered),/digest changed/);
});

test('canary failure stops later traffic increments and recovery is independently measured',async t=>{
  const f=await fixture(t),definition=f.definition(['gamma']);await f.workflow('baseline',f.v1,definition).workflow.start();
  definition.stages[0]!.strategyId='canary';definition.stages[0]!.parameters={weights:[10,50,100]};definition.stages[0]!.rollback='automatic';f.controls.failedStage='gamma';f.calls.length=0;
  const result=await f.workflow('canary-failure',f.v2,definition).workflow.start();assert.equal(result.stages[0]!.status,'rolled-back');
  assert.deepEqual(f.calls.map(call=>call.operation),['deploy-candidate','set-traffic','restore']);
  assert.equal(result.stages[0]!.operations.some(op=>op.id==='traffic-50'),false);assert.equal(result.stages[0]!.operations.some(op=>op.check?.request.reason==='recovery'),true);
});

test('failed recovery never promotes or retries restoration; blue green uses its own operation port',async t=>{
  const f=await fixture(t),definition=f.definition(['gamma']);await f.workflow('baseline',f.v1,definition).workflow.start();
  definition.stages[0]!.rollback='automatic';f.controls.failedStage='gamma';f.controls.failedRecovery=true;f.calls.length=0;
  const run=f.workflow('recovery-failed',f.v2,definition),result=await run.workflow.start();assert.equal(result.status,'failed');assert.equal(result.stages[0]!.status,'failed');
  assert.deepEqual(f.calls.map(call=>call.operation),['deploy','restore']);await assert.rejects(()=>run.workflow.start(),/already started/);
  f.controls.failedStage=undefined;f.controls.failedRecovery=false;const blue=f.definition(['blue']);blue.stages[0]!.strategyId='blue-green';f.calls.length=0;
  assert.equal((await f.workflow('blue',f.v2,blue).workflow.start()).status,'passed');
  assert.deepEqual(f.calls.map(call=>call.operation),['prepare-environment','switch-traffic','promote-environment']);
});

test('failed durable result write after an effect retains intent and never retries that effect',async t=>{
  const f=await fixture(t),run=f.workflow('persist-failure'),save=run.store.save.bind(run.store);let failed=false;
  run.store.save=async state=>{
    if(!failed&&state.stages[0]!.operations.some(operation=>operation.kind==='action'&&operation.status==='succeeded')){failed=true;throw Error('simulated local disk failure');}
    await save(state);
  };
  const state=await run.workflow.start();assert.equal(state.status,'incomplete');assert.equal(f.calls.length,1);assert.ok((await f.targetStore.load(f.definition().stages[0]!.target)).pending);
  await assert.rejects(()=>run.workflow.start(),/already started/);assert.equal(f.calls.length,1);
});

test('admission rejects multiplicative check plans that exceed durable recording limits before any effect',async t=>{
  const f=await fixture(t),definition=f.definition();definition.stages[0]!.strategyId='oversized';
  definition.stages[0]!.checks=Array.from({length:4},(_,index)=>({runnerId:'check-a',suiteId:'access-'+index,suiteDigest:'c'.repeat(64)}));
  const runner:CheckRunner={...f.runner,suites:()=>definition.stages[0]!.checks.map(check=>({id:check.suiteId,label:check.suiteId,digest:check.suiteDigest,kind:'contract'}))};
  const registry:PipelineRegistry={...f.registry,checks:[runner],strategies:[{id:'oversized',label:'Oversized',plan:()=>({steps:[{kind:'action',id:'deploy',operation:'deploy'},...Array.from({length:127},(_,index)=>({kind:'check' as const,id:'check-'+index}))]})}]};
  assert.throws(()=>f.workflow('oversized',f.v2,definition,registry),/recording limits/);assert.equal(f.calls.length,0);
});

test('expanded strategy step IDs cannot collide with observations, acceptance or recovery receipt IDs',async t=>{
  const f=await fixture(t),definition=f.definition();definition.stages[0]!.strategyId='custom';
  for(const steps of [
    [{kind:'action' as const,id:'before',operation:'deploy'}],
    [{kind:'action' as const,id:'acceptance-0',operation:'deploy'}],
    [{kind:'action' as const,id:'deploy',operation:'deploy'},{kind:'check' as const,id:'a'.repeat(128)}],
    [{kind:'action' as const,id:'check-0',operation:'deploy'},{kind:'check' as const,id:'check'}],
  ]){
    const registry={...f.registry,strategies:[{id:'custom',label:'Custom',plan:()=>({steps})}]};
    assert.throws(()=>f.workflow('collision',f.v2,definition,registry),/conflicts|expanded pipeline operation/);
  }
  assert.equal(f.calls.length,0);
});

test('native scope digest prevents rebinding unchanged visible steps to changed private strategy parameters',async t=>{
  const f=await fixture(t),run=f.workflow('parameter-binding'),result=await run.workflow.start();
  const definition=f.definition();definition.stages[0]!.parameters={hostMode:'changed'};
  const changed=f.workflow('other-definition',f.v2,definition),expected=await changed.workflow.snapshot();
  const state=structuredClone(result);state.definition=definition;state.definitionDigest=expected.definitionDigest;await writeFile(run.store.path,JSON.stringify(state));
  const receipt=result.recordings[0]!,evidence=JSON.parse(await readFile(receipt.evidencePath,'utf8'));evidence.definitionDigest=expected.definitionDigest;await writeFile(receipt.evidencePath,JSON.stringify(evidence));
  const rebound=new PipelineWorkflow({definition,release:f.v2,registry:f.registry,store:run.store,targetStore:f.targetStore});
  await assert.rejects(()=>rebound.snapshot(),/scope identity/);assert.equal(f.calls.length,1);
});
