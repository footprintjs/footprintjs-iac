import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SourcePreparationWorkflow,FileSourcePreparationStore,loadSourcePreparationRecording} from '../src/source-preparation/node.ts';
import type {SourcePreparationAdapters,SourcePreparationDefinition,SourcePreparationStageId} from '../src/source-preparation/index.ts';
import {sourcePreparationReceiptDigest} from '../src/source-preparation/index.ts';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const directory=await mkdtemp(join(tmpdir(),'iac-source-preparation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const definition:SourcePreparationDefinition={id:'neo-input',label:'Prepare application version',target:{id:'registered',scope:'registered-scope'},source:{repository:'https://github.com/company/app.git',ref:'reviewed'},recipe:{id:'app-package',digest:'a'.repeat(64)},configurationDigest:'b'.repeat(64)};
 const calls:SourcePreparationStageId[]=[],controls:{fail?:SourcePreparationStageId;mismatch?:'revision'|'source'|'recipe'|'artifact';gate?:Promise<void>}={},store=new FileSourcePreparationStore(directory);
 const perform=async(id:SourcePreparationStageId)=>{const state=await store.load();assert.equal(state?.status,'running');assert.equal(state?.stages.find(s=>s.id===id)?.status,'running');calls.push(id);if(controls.fail===id)throw Error('PRIVATE-SECRET-FAILURE');if(id==='build'&&controls.gate)await controls.gate;};
 const artifacts=[{id:'app',digest:'c'.repeat(64),reference:'local/app-reviewed'}];
 const adapters:SourcePreparationAdapters={source:{async resolve(source){await perform('resolve');return {...source,commit:(controls.mismatch==='revision'?'9':'1').repeat(40),tree:'2'.repeat(40)};},async fetch(revision){await perform('fetch');return {revision:{...revision,...controls.mismatch==='source'?{tree:'3'.repeat(40)}:{}},location:'/private/prepared-source'};}},
  build:{async build(_source,recipe){await perform('build');return {recipeDigest:controls.mismatch==='recipe'?'f'.repeat(64):recipe.digest,artifacts,metadata:{privatePath:'/private/build-handle'}};}},
  artifacts:{async publish(build){await perform('publish');return {artifacts:build.artifacts.map(a=>({...a,...controls.mismatch==='artifact'?{digest:'e'.repeat(64)}:{}}))};}}};
 return {directory,definition,calls,controls,store,adapters,workflow:(change:Partial<SourcePreparationDefinition>={})=>new SourcePreparationWorkflow({definition:{...definition,...change},store,adapters})};
}

test('source preparation records only four real stages with durable intent, exact receipts and effect-free replay',async t=>{
 const f=await fixture(t),workflow=f.workflow(),seen:string[]=[];workflow.subscribe(s=>seen.push(s.status));workflow.subscribe(()=>{throw Error('viewer');});
 assert.equal((await workflow.snapshot()).status,'idle');assert.deepEqual(f.calls,[]);
 const result=await workflow.start();assert.equal(result.status,'passed');assert.deepEqual(f.calls,['resolve','fetch','build','publish']);assert.equal(result.events.length,8);assert.ok(seen.includes('running'));
 assert.deepEqual(result.stages.map(s=>s.id),['resolve','fetch','build','publish']);assert.equal(result.recordings.length,1);
 const receipt=result.recordings[0]!,native=await loadSourcePreparationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:result.definitionDigest,executionId:result.executionId!});
 assert.equal(native.snapshot.commitLog.length,4);assert.equal(native.snapshot.sharedState.publication!==undefined,true);
 for(const p of [receipt.evidencePath,receipt.tracePath]){const bytes=await readFile(p,'utf8');for(const secret of ['/private/prepared-source','/private/build-handle','PRIVATE-SECRET-FAILURE'])assert.equal(bytes.includes(secret),false);}
 assert.deepEqual(await f.workflow().snapshot(),result);assert.deepEqual(await f.workflow().start(),result);assert.equal(f.calls.length,4);
});

test('source failure is retained and downstream adapters never run or silently retry',async t=>{
 for(const id of ['resolve','fetch','build','publish'] as const){const f=await fixture(t);f.controls.fail=id;const result=await f.workflow().start();assert.equal(result.status,'failed');assert.equal(f.calls.at(-1),id);assert.equal(result.recordings[0]?.status,'failed');const count=f.calls.length;await assert.rejects(f.workflow().start(),/already started/);assert.equal(f.calls.length,count);assert.equal(JSON.stringify(result).includes('PRIVATE-SECRET-FAILURE'),false);}
});

test('reviewed revision, fetched source, recipe and artifact substitutions fail before deployment can be considered',async t=>{
 for(const mismatch of ['revision','source','recipe','artifact'] as const){const f=await fixture(t);f.controls.mismatch=mismatch;const expectedRevision={...f.definition.source,commit:'1'.repeat(40),tree:'2'.repeat(40)};const result=await f.workflow({expectedRevision}).start();assert.equal(result.status,'failed');assert.equal(result.stages.find(s=>s.status==='failed')?.id,{revision:'resolve',source:'fetch',recipe:'build',artifact:'publish'}[mismatch]);}
});

test('another reader reports an interrupted source attempt as incomplete without replaying work',async t=>{
 const f=await fixture(t);let release!:()=>void;f.controls.gate=new Promise<void>(resolve=>{release=resolve;});let arrived!:()=>void;const started=new Promise<void>(resolve=>{arrived=resolve;}),build=f.adapters.build.build;
 f.adapters.build.build=async(...args)=>{arrived();return build(...args);};const workflow=f.workflow(),running=workflow.start();t.after(async()=>{release();await running;});await started;
 assert.equal((await workflow.snapshot()).status,'running');assert.equal((await f.workflow().snapshot()).status,'incomplete');await assert.rejects(f.workflow().start(),/locked|already started/);release();assert.equal((await running).status,'passed');assert.equal(f.calls.filter(x=>x==='build').length,1);
});

test('changed inputs, tampered receipts and a missing native trace cannot admit a prepared source',async t=>{
 const f=await fixture(t),result=await f.workflow().start();await assert.rejects(f.workflow({configurationDigest:'d'.repeat(64)}).snapshot(),/changed|binding/);
 const changed=structuredClone(result);changed.results.publication!.artifacts[0]!.reference='local/substituted';await writeFile(f.store.path,JSON.stringify(changed));await assert.rejects(f.workflow().snapshot(),/receipt|native|differ/);
 await writeFile(f.store.path,JSON.stringify(result));await rm(result.recordings[0]!.tracePath);await assert.rejects(f.workflow().snapshot(),/ENOENT|trace/);
});

test('failed durable intent prevents the first source side effect',async t=>{
 const f=await fixture(t);f.store.save=async()=>{throw Error('intent unavailable');};await assert.rejects(f.workflow().start(),/intent unavailable/);assert.deepEqual(f.calls,[]);
});

test('mutating caller options cannot redirect a bound preparation into another private store',async t=>{
 const f=await fixture(t),other=new FileSourcePreparationStore(join(f.directory,'other-attempt'));
 const options={definition:f.definition,store:f.store,adapters:f.adapters},workflow=new SourcePreparationWorkflow(options);options.store=other;
 const result=await workflow.start();assert.equal(result.status,'passed');assert.equal((await f.store.load())?.status,'passed');assert.equal(await other.load(),undefined);
});

test('source receipt identity binds exact version, artifacts and native run beyond the definition digest',async t=>{
 const f=await fixture(t),initial=await f.workflow().snapshot();assert.throws(()=>sourcePreparationReceiptDigest({}),/preparation/);assert.throws(()=>sourcePreparationReceiptDigest(initial),/preparation/);
 const result=await f.workflow().start(),digest=sourcePreparationReceiptDigest(result);assert.match(digest,/^[a-f0-9]{64}$/);assert.equal(sourcePreparationReceiptDigest(await f.workflow().snapshot()),digest);
 const revision=structuredClone(result);revision.results.revision!.commit='5'.repeat(40);revision.results.source!.revision.commit='5'.repeat(40);assert.notEqual(sourcePreparationReceiptDigest(revision),digest);
 const artifact=structuredClone(result);artifact.results.build!.artifacts[0]!.digest='6'.repeat(64);artifact.results.publication!.artifacts[0]!.digest='6'.repeat(64);assert.notEqual(sourcePreparationReceiptDigest(artifact),digest);
 const run=structuredClone(result);run.recordings[0]!.runId='another-native-run';assert.notEqual(sourcePreparationReceiptDigest(run),digest);
});
