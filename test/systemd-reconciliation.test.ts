import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flowChart } from 'footprintjs';
import { createSystemdDeploymentAdapter } from '../src/deployment-strategy/index.ts';
import type { SystemdDeploymentOptions, SystemdHostObservation, SystemdOutcomeInspection } from '../src/deployment-strategy/types.ts';
import { executionScopeFactory, type ExecutionScope } from '../src/execution/scope.ts';
import { runApplyChart } from '../src/execution/run-apply-chart.ts';
import { FileStateStore } from '../src/store.ts';
import { fingerprint } from '../src/util.ts';

async function nativeProof(directory:string,label:string,operationId:string,shared:Record<string,unknown>,extra:Record<string,unknown>={}){
  const store=new FileStateStore(join(directory,'child'));
  const chart=flowChart<void,ExecutionScope>('Record actual operation',scope=>{
    for(const [key,value]of Object.entries(shared))scope.setValue(key,value);
  },label).setScopeFactory(executionScopeFactory).build();
  const recorded=await runApplyChart(chart,label,join(directory,'child'));
  const evidence=JSON.parse(JSON.stringify({version:1,kind:'test-native-operation',operationId,definitionDigest:'e'.repeat(64),status:shared.outcome??'incomplete',runId:recorded.snapshot.runId,stack:'owned-app',...extra,...recorded}));
  const evidencePath=await store.saveEvidence(label,evidence);
  return{runId:recorded.snapshot.runId,evidencePath,tracePath:recorded.tracePath!,digest:fingerprint(evidence),complete:true};
}

async function fixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'systemd-reconcile-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let applies=0,inspections=0,fail=true,mode='failed',activation:Awaited<ReturnType<typeof nativeProof>>;
  const facts:SystemdHostObservation={identityDigest:'a'.repeat(64),units:[{name:'app.service',exists:true,fragmentPath:'/etc/systemd/system/app.service',fragmentDigest:'b'.repeat(64),configurationDigest:'b'.repeat(64),activeState:'active',invocationId:'initial',appliedSpecDigest:null}]};
  const binding=(id:string)=>({suiteId:id,requiredCheckIds:[id],runner:{id,suites:()=>[{id,label:id,kind:'verification',digest:'c'.repeat(64)}],async run(request:any){return{request,status:'passed' as const,checks:[{id,status:'passed' as const}]};}}});
  const options:SystemdDeploymentOptions={id:'owned-systemd',stack:'owned-app',stateDirectory:directory,releaseDigest:'d'.repeat(64),registration:{hostId:'owned-host',scope:'owned-target',identityDigest:facts.identityDigest},units:[{id:'app',name:'app.service',fragmentPath:'/etc/systemd/system/app.service',configurationDigest:'b'.repeat(64)}],
    host:{async inspect(){return structuredClone(facts);},async applyUnits(request,context){applies++;activation=await nativeProof(directory,`activation-${applies}`,context.operationId,{runtimeActivated:true});if(fail){facts.units[0]!.activeState='failed';throw Error('effect-returned-but-service-failed');}facts.units[0]!.activeState='active';facts.units[0]!.appliedSpecDigest=request.desiredSpecDigest;},
      async reconcileUnits(request,context){
        inspections++;assert.deepEqual(request.units,facts.units.map(unit=>unit.name));assert.equal(context.expectedUnits[0]!.invocationId,'initial');
        const original=mode==='native-control-unknown'?await nativeProof(directory,'control-unknown',context.operationId,{runtimeActivated:false})
          :mode==='original-ready'?await nativeProof(directory,'original-ready',context.operationId,{runtimeActivated:true,outcome:'ready'})
          :mode==='negative-observation-missing'?await nativeProof(directory,'negative-observation-missing',context.operationId,{runtimeActivated:true,outcome:'verification-failed'})
          :mode==='original-verification-failed'?await nativeProof(directory,'original-verification-failed',context.operationId,{runtimeActivated:true,outcome:'verification-failed',observation:{ready:false,packageDigest:null,evidence:{complete:true}}}):activation;
        const observation=await nativeProof(directory,`observation-${inspections}`,context.operationId,{outcome:'verification-failed'});
        const captured=await nativeProof(directory,`settlement-${inspections}`,mode==='wrong-operation'?'foreign-operation':context.operationId,
          {settlement:{acknowledged:mode!=='unacknowledged',operationId:context.operationId,packageDigest:'e'.repeat(64)},outcome:'verification-failed'},
          {originalRunId:original.runId,originalRecordingDigest:original.digest,originalEvidencePath:original.evidencePath,originalTracePath:original.tracePath,
            inspectionRunId:observation.runId,inspectionRecordingDigest:observation.digest,inspectionEvidencePath:observation.evidencePath,inspectionTracePath:observation.tracePath,relatedEvidence:mode==='missing-original'?[]:[original,observation]});
        const {complete,...proof}=captured;if(mode==='forged-digest')proof.digest='f'.repeat(64);
        const jobs=facts.units.map((unit,index)=>({unit:unit.name,jobId:mode==='busy'&&index===0?'23':null}));
        return{runtimeControlReturned:mode!=='control-unknown',jobs,proof};
      }},preflightChecks:binding('preflight'),applicationChecks:binding('application')};
  return{directory,options,facts,counts:()=>({applies,inspections}),setMode:(value:string)=>{mode=value;},recover:()=>{fail=false;}};
}

test('known failed reconciliation is native, append-only, observation-only and permits one new reviewed deployment',async t=>{
  const f=await fixture(t),controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});
  assert.equal((await controller.apply(review.reviewId!)).status,'incomplete');
  const before=await controller.snapshot() as any,attempt=structuredClone(before.state.attempts[0]),master=structuredClone(before.master);
  const nativePath=attempt.result.deployment.evidencePath,nativeBytes=await readFile(nativePath,'utf8');
  const resourceStore=new FileStateStore(join(f.directory,'resources')),pending=await resourceStore.load('owned-app');
  assert.ok(pending.resources['systemd-services']!.pending);
  const result=await controller.reconcile!(review.reviewId!);
  assert.equal(result.status,'reconciled-failed');assert.equal(result.promoted,false);assert.equal(result.reconciliation?.status,'failed');
  assert.deepEqual(f.counts(),{applies:1,inspections:1});
  const after=await controller.snapshot() as any;
  assert.deepEqual(after.state.attempts[0],attempt);assert.deepEqual(after.master,master);assert.equal(await readFile(nativePath,'utf8'),nativeBytes);
  const settled=await resourceStore.load('owned-app');assert.equal(settled.resources['systemd-services']!.pending,undefined);
  assert.equal(settled.resources['systemd-services']!.fingerprint,pending.resources['systemd-services']!.fingerprint);
  assert.equal(after.master.appliedDigest,null);assert.equal(after.state.reconciliations.length,1);
  const reopened=createSystemdDeploymentAdapter(f.options);await reopened.snapshot();
  assert.deepEqual(await reopened.reconcile!(review.reviewId!),result);assert.deepEqual(f.counts(),{applies:1,inspections:1});
  f.recover();const corrected=createSystemdDeploymentAdapter({...f.options,releaseDigest:'e'.repeat(64)}),next=await corrected.plan({revisionId:'two'});
  assert.equal(next.ok,true);assert.equal((await corrected.apply(next.reviewId!)).promoted,true);assert.deepEqual(f.counts(),{applies:2,inspections:1});
});

test('busy, missing control, nonterminal units and unadmitted native settlement keep the exact intent pending',async t=>{
  for(const mode of ['busy','control-unknown','native-control-unknown','missing-original','original-ready','negative-observation-missing','activating','unacknowledged','wrong-operation','forged-digest'])await t.test(mode,async sub=>{
    const f=await fixture(sub),controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});
    await controller.apply(review.reviewId!);f.setMode(mode);if(mode==='activating')f.facts.units[0]!.activeState='activating';
    const store=new FileStateStore(join(f.directory,'resources')),before=await store.load('owned-app');
    assert.equal((await controller.reconcile!(review.reviewId!)).status,'incomplete');
    assert.deepEqual(await store.load('owned-app'),before);assert.deepEqual(f.counts(),{applies:1,inspections:1});
    await assert.rejects(()=>controller.plan({revisionId:'two'}),/unconfirmed|inspect/);
    await createSystemdDeploymentAdapter(f.options).snapshot();assert.deepEqual(f.counts(),{applies:1,inspections:1});
  });
});

test('a complete original negative observation may be reconciled without treating an original ready run as failure',async t=>{
  const f=await fixture(t),controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});
  await controller.apply(review.reviewId!);f.setMode('original-verification-failed');
  assert.equal((await controller.reconcile!(review.reviewId!)).status,'reconciled-failed');assert.deepEqual(f.counts(),{applies:1,inspections:1});
});

test('a failed group with an active sibling has quiescent deployment control and may close without restarting either unit',async t=>{
  const f=await fixture(t);
  f.facts.units.push({...f.facts.units[0]!,name:'worker.service',fragmentPath:'/etc/systemd/system/worker.service',invocationId:'worker-initial'});
  f.options.units=[...f.options.units,{id:'worker',name:'worker.service',fragmentPath:'/etc/systemd/system/worker.service',configurationDigest:'b'.repeat(64)}];
  const controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});
  await controller.apply(review.reviewId!);assert.deepEqual(f.facts.units.map(unit=>unit.activeState),['failed','active']);
  f.setMode('original-verification-failed');
  const before=structuredClone(f.facts),result=await controller.reconcile!(review.reviewId!);
  assert.equal(result.status,'reconciled-failed');assert.deepEqual(f.facts,before);assert.deepEqual(f.counts(),{applies:1,inspections:1});
  const snapshot=await createSystemdDeploymentAdapter(f.options).snapshot() as any;assert.equal(snapshot.state.attempts[0].status,'incomplete');
  assert.equal(snapshot.master.appliedDigest,null);assert.deepEqual(f.counts(),{applies:1,inspections:1});
});

test('active-only, transitioning or unknown siblings cannot close a partial group failure',async t=>{
  for(const state of ['active-only','activating','deactivating','unknown'])await t.test(state,async sub=>{
    const f=await fixture(sub);f.facts.units.push({...f.facts.units[0]!,name:'worker.service',fragmentPath:'/etc/systemd/system/worker.service'});
    f.options.units=[...f.options.units,{id:'worker',name:'worker.service',fragmentPath:'/etc/systemd/system/worker.service',configurationDigest:'b'.repeat(64)}];
    const controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});await controller.apply(review.reviewId!);
    if(state==='active-only')f.facts.units[0]!.activeState='active';else f.facts.units[1]!.activeState=state;
    assert.equal((await controller.reconcile!(review.reviewId!)).status,'incomplete');assert.deepEqual(f.counts(),{applies:1,inspections:1});
    assert.ok((await new FileStateStore(join(f.directory,'resources')).load('owned-app')).resources['systemd-services']!.pending);
  });
});

test('retained reconciliation cannot be forged into closure or reopened without its native child proof',async t=>{
  const f=await fixture(t),controller=createSystemdDeploymentAdapter(f.options),review=await controller.plan({revisionId:'one'});
  await controller.apply(review.reviewId!);f.setMode('busy');await controller.reconcile!(review.reviewId!);
  const path=join(f.directory,'systemd-deployment.json'),bytes=await readFile(path,'utf8'),state=JSON.parse(bytes);
  state.reconciliations[0].status='reconciled-failed';await writeFile(path,JSON.stringify(state));
  await assert.rejects(()=>controller.plan({revisionId:'forged'}),/admitted|binding/);assert.deepEqual(f.counts(),{applies:1,inspections:1});
  await writeFile(path,bytes);f.setMode('failed');await controller.reconcile!(review.reviewId!);
  const closed=JSON.parse(await readFile(path,'utf8')),proof=closed.reconciliations.at(-1).reconciliation;
  await rm(proof.evidencePath);await assert.rejects(()=>controller.snapshot());assert.deepEqual(f.counts(),{applies:1,inspections:2});
});
