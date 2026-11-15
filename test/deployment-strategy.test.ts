import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentStrategyRegistry, createKubernetesDeploymentAdapter, createSystemdDeploymentAdapter } from '../src/deployment-strategy/index.ts';
import type { SystemdHostObservation } from '../src/deployment-strategy/types.ts';
import { createDeploymentRecorder } from '../src/progress/recorder.ts';

async function fixture(t: test.TestContext) {
 const directory = await mkdtemp(join(tmpdir(),'deployment-strategy-')); t.after(()=>rm(directory,{recursive:true,force:true}));
 let count=0, checks=0, fail=false, unknown=false;
 const facts:SystemdHostObservation={identityDigest:'a'.repeat(64),units:[{name:'owned-neo.service',exists:true,fragmentPath:'/etc/systemd/system/owned-neo.service',fragmentDigest:'b'.repeat(64),configurationDigest:'b'.repeat(64),activeState:'active',invocationId:'original-invocation',appliedSpecDigest:null}]};
 const binding=(id:string)=>{const suite={id,label:id,kind:'verification',digest:'c'.repeat(64)};return {suiteId:id,requiredCheckIds:[id],runner:{id,suites:()=>[suite],async run(request:any){checks++;return {request,status:fail?'failed' as const:'passed' as const,checks:[{id,status:fail?'failed' as const:'passed' as const}]};}}};};
 const options={transaction:'independent' as const,id:'systemd',stack:'owned-neo',stateDirectory:directory,releaseDigest:'d'.repeat(64),registration:{hostId:'owned-host',scope:'local-owned-host',identityDigest:'a'.repeat(64)},units:[{id:'neo-service',name:'owned-neo.service',fragmentPath:'/etc/systemd/system/owned-neo.service',configurationDigest:'b'.repeat(64)}],host:{async inspect(){return structuredClone(facts);},async applyUnit(request:any){count++;facts.units[0]!.appliedSpecDigest=request.desiredSpecDigest;facts.units[0]!.invocationId='next-invocation';if(unknown)throw Error('PRIVATE-RAW-ERROR');}},preflightChecks:binding('preflight'),applicationChecks:binding('application')};
 return {options,facts,count:()=>count,checks:()=>checks,setFail:()=>{fail=true;},setUnknown:()=>{unknown=true;}};
}

test('registered systemd uses the native review, engine, application checks and one-use intent',async t=>{
 const f=await fixture(t), adapter=createSystemdDeploymentAdapter(f.options), registry=new DeploymentStrategyRegistry({adapters:[adapter]});
 assert.equal(f.count(),0);assert.deepEqual(registry.list(),[{id:'systemd',kind:'systemd'}]);
 const review=await registry.select('systemd').plan({revisionId:'neo-one'});assert.equal(review.ok,true);assert.equal(f.count(),0);
 const result=await adapter.apply(review.reviewId!);assert.equal(result.promoted,true);assert.equal(f.count(),1);assert.ok(f.checks()>=3);
 await assert.rejects(()=>adapter.apply(review.reviewId!),/consumed|current/);
 const snapshot=await adapter.snapshot();assert.ok(snapshot);
 const again=await adapter.plan({revisionId:'neo-same'});assert.equal(again.ok,true);assert.equal((await adapter.apply(again.reviewId!)).promoted,true);assert.equal(f.count(),1);
});

test('host identity, fragment identity and running invocation drift block before restarts',async t=>{
 for(const drift of ['machine','fragment','invocation']){
  const f=await fixture(t),adapter=createSystemdDeploymentAdapter(f.options);const r=await adapter.plan({revisionId:'neo-one'});
  if(drift==='machine')f.facts.identityDigest='e'.repeat(64);else if(drift==='fragment')f.facts.units[0]!.fragmentDigest='e'.repeat(64);else f.facts.units[0]!.invocationId='external-restart';
  const result=await adapter.apply(r.reviewId!);assert.equal(result.promoted,false);assert.equal(f.count(),0);
 }
});

test('fresh preflight failure consumes the review without effects',async t=>{
 const f=await fixture(t),adapter=createSystemdDeploymentAdapter(f.options);const r=await adapter.plan({revisionId:'neo-one'});f.setFail();
 const result=await adapter.apply(r.reviewId!);assert.equal(result.status,'blocked');assert.equal(f.count(),0);await assert.rejects(()=>adapter.apply(r.reviewId!),/consumed|current/);
});

test('unknown service effects remain incomplete and never automatically retry',async t=>{
 const f=await fixture(t);f.setUnknown();const adapter=createSystemdDeploymentAdapter(f.options),r=await adapter.plan({revisionId:'neo-one'}),result=await adapter.apply(r.reviewId!);
 assert.equal(result.status,'incomplete');assert.equal(f.count(),1);await assert.rejects(()=>createSystemdDeploymentAdapter(f.options).plan({revisionId:'neo-two'}),/inspect|unconfirmed|incomplete/);
 assert.doesNotMatch(JSON.stringify(await adapter.snapshot()),/PRIVATE-RAW-ERROR/);
});

test('Kubernetes strategy delegates the existing guarded controller without a parallel engine',async()=>{
 let calls=0;const adapter=createKubernetesDeploymentAdapter({id:'kube',controller:{async plan(){calls++;return{ok:true,reviewId:'review'};},async apply(){calls++;return{ok:true,promoted:true,status:'promoted'};},async snapshot(){return{status:'passed'};}}});
 const registry=new DeploymentStrategyRegistry({adapters:[adapter]});assert.equal(calls,0);assert.throws(()=>registry.select('unregistered'),/registered/);
 assert.equal((await registry.select('kube').plan({revisionId:'one'})).ok,true);assert.equal((await adapter.apply('review')).promoted,true);assert.equal(calls,2);
 assert.throws(()=>new DeploymentStrategyRegistry({adapters:[adapter,adapter]}),/duplicate/);
});


test('read-only snapshot binds promoted results to actual native application evidence',async t=>{
 const f=await fixture(t),adapter=createSystemdDeploymentAdapter(f.options),review=await adapter.plan({revisionId:'neo-one'});
 assert.equal((await adapter.apply(review.reviewId!)).promoted,true);
 const path=join(f.options.stateDirectory,'systemd-deployment.json');const state=JSON.parse(await readFile(path,'utf8'));
 state.attempts[0].result.applicationChecks.result.checks[0].status='failed';await writeFile(path,JSON.stringify(state));
 await assert.rejects(()=>adapter.snapshot(),/evidence|native|admitted/);
});

test('missing installed units yield a recorded refusal rather than an attempted install',async t=>{
 const f=await fixture(t);f.facts.units[0]!.exists=false;const adapter=createSystemdDeploymentAdapter(f.options),review=await adapter.plan({revisionId:'neo-one'});
 assert.equal(review.ok,false);assert.equal(f.count(),0);
});


test('coupled units default to one owned systemd group transaction',async t=>{
 const f=await fixture(t);f.facts.units.push({...f.facts.units[0]!,name:'owned-tools.service',fragmentPath:'/etc/systemd/system/owned-tools.service'});
 let transactions=0;const {transaction,...original}=f.options;
 const options={...original,units:[...original.units,{id:'tools-service',name:'owned-tools.service',fragmentPath:'/etc/systemd/system/owned-tools.service',configurationDigest:'b'.repeat(64)}],host:{inspect:original.host.inspect,async applyUnits(request:any,context:any){transactions++;assert.deepEqual(request.units,['owned-neo.service','owned-tools.service']);assert.equal(context.expectedUnits.length,2);for(const unit of f.facts.units){unit.appliedSpecDigest=request.desiredSpecDigest;unit.invocationId='transaction-invocation';}}}};
 const adapter=createSystemdDeploymentAdapter(options),review=await adapter.plan({revisionId:'one-group'});assert.equal(review.ok,true);assert.equal((review as any).masterReview.plan.operations.length,1);
 const result=await adapter.apply(review.reviewId!);assert.equal(result.promoted,true);assert.equal(transactions,1);
});


test('new approved unit configuration uses the same physical ledger and a fresh revision',async t=>{
 const f=await fixture(t),original=createSystemdDeploymentAdapter(f.options),first=await original.plan({revisionId:'old-configuration'});
 assert.equal((await original.apply(first.reviewId!)).promoted,true);
 f.facts.units[0]!.fragmentDigest='f'.repeat(64);f.facts.units[0]!.configurationDigest='e'.repeat(64);
 const updated=createSystemdDeploymentAdapter({...f.options,units:f.options.units.map(unit=>({...unit,configurationDigest:'e'.repeat(64)}))});
 const next=await updated.plan({revisionId:'new-configuration'});assert.equal(next.ok,true);assert.equal((next as any).masterReview.plan.operations[0].action,'update');
 assert.equal((await updated.apply(next.reviewId!)).promoted,true);assert.equal(f.count(),2);
});

test('application check catalog changes during effects cannot promote an unreviewed suite',async t=>{
 const f=await fixture(t),oldApply=f.options.host.applyUnit,suite=f.options.applicationChecks.runner.suites()[0]!;let applicationRuns=0;
 const options={...f.options,applicationChecks:{...f.options.applicationChecks,runner:{...f.options.applicationChecks.runner,suites:()=>[suite],async run(request:any){applicationRuns++;return{request,status:'passed' as const,checks:[{id:'application',status:'passed' as const}]};}}},host:{...f.options.host,async applyUnit(request:any){await oldApply(request);suite.digest='e'.repeat(64);}}};
 const adapter=createSystemdDeploymentAdapter(options),review=await adapter.plan({revisionId:'catalog-one'}),result=await adapter.apply(review.reviewId!);
 assert.equal(result.promoted,false);assert.equal(result.status,'verification-failed');assert.equal(applicationRuns,0);assert.equal(f.count(),1);
});


test('snapshot rejects another target application or engine receipt with the same graph',async t=>{
 const left=await fixture(t),right=await fixture(t);right.options.registration.hostId='other-host';
 const one=createSystemdDeploymentAdapter(left.options),two=createSystemdDeploymentAdapter(right.options);
 const r1=await one.plan({revisionId:'same-version'}),r2=await two.plan({revisionId:'same-version'});await one.apply(r1.reviewId!);await two.apply(r2.reviewId!);
 const path=join(left.options.stateDirectory,'systemd-deployment.json'),saved=JSON.parse(await readFile(path,'utf8'));
 const foreign=JSON.parse(await readFile(join(right.options.stateDirectory,'systemd-deployment.json'),'utf8'));
 for(const field of ['applicationChecks','deployment']){const changed=structuredClone(saved);changed.attempts[0].result[field]=foreign.attempts[0].result[field];await writeFile(path,JSON.stringify(changed));await assert.rejects(()=>one.snapshot(),/native|admitted/);}
});


test('systemd live progress comes from its native engine recorder and chart', async t => {
 const f = await fixture(t), recorder = createDeploymentRecorder({id:'systemd-native-progress'});
 const seen: string[] = [];
 recorder.subscribe(event => seen.push(event.status));
 const adapter = createSystemdDeploymentAdapter({...f.options, recorders:[recorder], chartObservers:[recorder]});
 const review = await adapter.plan({revisionId:'native-progress'});
 assert.equal(seen.length, 0);
 const result = await adapter.apply(review.reviewId!);
 assert.equal(result.promoted, true);
 assert.ok(seen.includes('deploying'));
 assert.equal(seen.at(-1), 'ready');
 const snapshot = recorder.getSnapshot();
 assert.ok(snapshot.chart?.resources.some(resource => resource.resourceId === 'neo-service'));
 assert.equal(snapshot.resources['neo-service']?.status, 'ready');
 assert.equal(snapshot.ignoredEvents, 0);
 const count = seen.length;
 await adapter.snapshot();
 assert.equal(seen.length, count);
});
