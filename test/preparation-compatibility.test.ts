import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {SourcePreparationWorkflow,FileSourcePreparationStore} from '../src/source-preparation/node.ts';
import {ReleasePreparationWorkflow,FileReleasePreparationStore} from '../src/releases/node.ts';
import type {SourcePreparationDefinition,SourcePreparationAdapters,SourcePreparationState} from '../src/source-preparation/index.ts';
import type {ReleasePreparationState} from '../src/releases/preparation-types.ts';

type Golden={kind:'source'|'release';outcome:'passed'|'failed'|'pinned';state:SourcePreparationState|ReleasePreparationState;evidence:Record<string,any>;trace:string};
const golden=JSON.parse(await readFile(new URL('./fixtures/preparation-1781c22.json',import.meta.url),'utf8')) as {commit:string;fixtures:Golden[]};
const noEffects:SourcePreparationAdapters={source:{async resolve(){throw Error('replay resolved source');},async fetch(){throw Error('replay fetched source');}},
 build:{async build(){throw Error('replay built package');}},artifacts:{async publish(){throw Error('replay published package');}}};

test('pre-consolidation source and release captures reopen byte-for-byte without effects or history rewrites',async t=>{
 assert.equal(golden.commit,'1781c22b8573c38fbc0294a837cb3bafb90214e6');assert.equal(golden.fixtures.length,6);
 for(const fixture of golden.fixtures){
  const directory=await mkdtemp(join(tmpdir(),'iac-legacy-prepare-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const state=structuredClone(fixture.state),receipt=state.recordings[0]!;
  // Only the external transport envelope is relocated. Recorded native values,
  // stage addresses, run IDs, timestamps and original JSONL bytes are untouched.
  receipt.evidencePath=join(directory,basename(receipt.evidencePath));receipt.tracePath=join(directory,basename(receipt.tracePath));
  const evidence={...fixture.evidence,tracePath:receipt.tracePath};
  const store=fixture.kind==='source'?new FileSourcePreparationStore(directory):new FileReleasePreparationStore(directory);
  await writeFile(store.path,JSON.stringify(state));await writeFile(receipt.evidencePath,JSON.stringify(evidence));await writeFile(receipt.tracePath,fixture.trace);
  const before=new Map(await Promise.all((await readdir(directory)).map(async name=>[name,await readFile(join(directory,name),'utf8')] as const)));
  const workflow=fixture.kind==='source'?new SourcePreparationWorkflow({definition:state.definition,store:store as FileSourcePreparationStore,adapters:noEffects}):new ReleasePreparationWorkflow({definition:state.definition,store:store as FileReleasePreparationStore,adapters:noEffects,...'expectedRevision' in state?{expectedRevision:state.expectedRevision}:{}});
  assert.deepEqual(await workflow.snapshot(),state,`${fixture.kind}/${fixture.outcome} retains original interpretation`);
  if(fixture.outcome==='failed')await assert.rejects(()=>workflow.start(),/already started/);
  else {const replay=await workflow.start();assert.deepEqual(replay,state);assert.equal(Object.isFrozen(replay),fixture.kind==='source','retain the existing detached release replay and frozen source replay contracts');}
  for(const [name,bytes] of before)assert.equal(await readFile(join(directory,name),'utf8'),bytes,`${fixture.kind}/${fixture.outcome} ${name} is not rewritten`);
  assert.deepEqual((await readdir(directory)).filter(name=>name!=='locks').sort(),[...before.keys()].sort());
 }
});

test('reviewed release adapters remain bound when caller replaces build and publication methods',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-captured-build-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const definition:SourcePreparationDefinition={id:'bound-builder',label:'Bound builder',target:{id:'build',scope:'registered'},source:{repository:'https://github.com/example/app.git',ref:'reviewed'},recipe:{id:'package',digest:'a'.repeat(64)},configurationDigest:'b'.repeat(64)};
 const calls:string[]=[],artifacts=[{id:'app',digest:'c'.repeat(64),reference:'registry.example/app@sha256:'+'c'.repeat(64)}];
 const adapters:SourcePreparationAdapters={source:{async resolve(source){calls.push('resolve');return{...source,commit:'1'.repeat(40),tree:'2'.repeat(40)};},async fetch(revision){calls.push('fetch');return{revision,location:'/private/source'};}},
  build:{async build(_source,recipe){calls.push('build');return{recipeDigest:recipe.digest,artifacts};}},artifacts:{async publish(build){calls.push('publish');return{artifacts:build.artifacts};}}};
 const workflow=new ReleasePreparationWorkflow({definition,adapters,store:new FileReleasePreparationStore(directory)});
 adapters.build.build=async()=>{throw Error('replacement builder must not be invoked');};
 adapters.artifacts.publish=async()=>{throw Error('replacement publisher must not be invoked');};
 const result=await workflow.start();assert.equal(result.status,'passed');assert.deepEqual(calls,['resolve','fetch','build','publish']);assert.equal(result.release?.artifacts[0]?.digest,artifacts[0]!.digest);
});

async function captureFixture(t:{after(fn:()=>Promise<void>):void},kind:'source'|'release'){
 const directory=await mkdtemp(join(tmpdir(),'iac-prepare-capture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const definition:SourcePreparationDefinition={id:'capture-'+kind,label:'Capture preparation',target:{id:'registered',scope:'approved'},source:{repository:'https://github.com/example/app.git',ref:'reviewed'},recipe:{id:'package',digest:'a'.repeat(64)},configurationDigest:'b'.repeat(64)};
 const calls:string[]=[],artifacts=[{id:'app',digest:'c'.repeat(64),reference:'registry.example/app@sha256:'+'c'.repeat(64)}];
 const adapters:SourcePreparationAdapters={source:{async resolve(source){calls.push('resolve');return{...source,commit:'1'.repeat(40),tree:'2'.repeat(40)};},async fetch(revision){calls.push('fetch');return{revision,location:'/private/source'};}},
  build:{async build(_source,recipe){calls.push('build');return{recipeDigest:recipe.digest,artifacts};}},artifacts:{async publish(build){calls.push('publish');return{artifacts:build.artifacts};}}};
 const store=kind==='source'?new FileSourcePreparationStore(directory):new FileReleasePreparationStore(directory);
 const workflow=()=>kind==='source'?new SourcePreparationWorkflow({definition,adapters,store:store as FileSourcePreparationStore}):new ReleasePreparationWorkflow({definition,adapters,store:store as FileReleasePreparationStore});
 return{calls,store,workflow};
}

test('both preparation wrappers retain incomplete capture after effects and never replay those effects',async t=>{
 for(const kind of ['source','release'] as const){
  const f=await captureFixture(t,kind),write=f.store.writeJson.bind(f.store);
  f.store.writeJson=async(path,value)=>{if(path!==f.store.path)throw Error('private capture unavailable');return write(path,value);};
  const state=await f.workflow().start();assert.equal(state.status,'incomplete',kind);assert.equal(state.recordings[0]?.status,'incomplete');
  assert.deepEqual(f.calls,['resolve','fetch','build','publish']);assert.equal((await f.workflow().snapshot()).status,'incomplete');
  await assert.rejects(()=>f.workflow().start(),/already started/);assert.equal(f.calls.length,4);
  assert.equal(JSON.stringify(state).includes('private capture unavailable'),false);
 }
});

test('a lost synced stage intent blocks its adapter in both preparation wrappers',async t=>{
 for(const kind of ['source','release'] as const){
  const f=await captureFixture(t,kind),save=f.store.save.bind(f.store) as (state:SourcePreparationState|ReleasePreparationState)=>Promise<void>;
  f.store.save=async(state:SourcePreparationState|ReleasePreparationState)=>{if(state.status==='running'&&state.stages[2]?.status==='running')throw Error('private stage intent unavailable');await save(state);};
  const state=await f.workflow().start();assert.equal(state.status,'incomplete',kind);assert.deepEqual(f.calls,['resolve','fetch']);
  await assert.rejects(()=>f.workflow().start(),/already started/);assert.equal(f.calls.length,2);
 }
});
