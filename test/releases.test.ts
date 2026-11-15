import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { defineReleaseManifest,readReleaseManifest,ManifestReleaseCatalog,ReleasePreparationWorkflow,FileReleasePreparationStore } from '../src/releases/node.ts';
import { readReleaseManifestShape } from '../src/releases/index.ts';
import type { ReleasePreparationDefinition } from '../src/releases/preparation-types.ts';
import type { DeliveryAdapters } from '../src/delivery/types.ts';
import { compileGraph } from '../src/graph/compile.ts';
import { defineSystemRevision,readSystemRevision } from '../src/master/index.ts';

const revision={repository:'https://github.com/acme/app.git',ref:'refs/tags/v1',commit:'1'.repeat(40),tree:'2'.repeat(40)};
const recipe={id:'app',digest:'a'.repeat(64)},artifacts=[{id:'web',digest:'sha256:'+'b'.repeat(64),reference:'registry/acme/web@sha256:'+'b'.repeat(64)}];
test('manifest seals source, recipe and every artifact; local source handles become stable public identities',()=>{
  for(const repository of [revision.repository,'/private/repository','file:///private/repository']){
    const manifest=defineReleaseManifest({id:'v1',source:{...revision,repository},recipe,artifacts});
    assert.deepEqual(readReleaseManifest(JSON.parse(JSON.stringify(manifest))),manifest);
    assert.deepEqual(readReleaseManifestShape(manifest),manifest);
    assert.equal(JSON.stringify(manifest).includes('/private/repository'),false);
    for(const mutation of ['source','recipe','artifact'] as const){const bad=structuredClone(manifest);
      if(mutation==='source')bad.source.commit='9'.repeat(40);
      if(mutation==='recipe')bad.recipe.digest='9'.repeat(64);
      if(mutation==='artifact')(bad.artifacts as typeof artifacts)[0]!.digest='9'.repeat(64);
      assert.throws(()=>readReleaseManifest(bad),/digest changed/);
    }
  }
  assert.throws(()=>defineReleaseManifest({id:'v1',source:revision,recipe,artifacts:[{...artifacts[0]!,reference:'/private/package.tgz'}]}),/host paths/);
  let invoked=false;const accessor={id:'v1',recipe,artifacts,get source(){invoked=true;return revision;}};
  assert.throws(()=>defineReleaseManifest(accessor));assert.equal(invoked,false,'invalid accessors are not invoked');
});
test('prepared catalog exposes registered immutable releases, never arbitrary source selectors',async()=>{
  const release=defineReleaseManifest({id:'v1',source:revision,recipe,artifacts}),catalog=new ManifestReleaseCatalog('approved',[release]);
  assert.equal((await catalog.list())[0]!.manifestDigest,release.digest);
  assert.deepEqual(catalog.manifest('v1'),release);assert.equal((await catalog.resolve('v1')).source.commit,revision.commit);
  await assert.rejects(()=>catalog.resolve('main'));
  assert.throws(()=>new ManifestReleaseCatalog('approved',[release,release]),/Duplicate/);
});
test('a local prepared release can enter the versioned master without exposing or accepting a filesystem path',()=>{
  const release=defineReleaseManifest({id:'local',source:{...revision,repository:'/private/app'},recipe,artifacts});
  const graph=compileGraph({name:'local-app',resources:[{id:'app',provider:'simulator',spec:{image:'app:v1'}}],boundaries:[],memberships:[],relations:[]});
  const input={revisionId:'local-v1',parentDigest:null,target:{id:'local',scope:'simulator'},graph,
    source:{repository:release.source.repository,commit:release.source.commit,tree:release.source.tree},artifacts:release.artifacts.map(artifact=>({...artifact,digest:artifact.digest.replace(/^sha256:/,'')}))};
  const master=defineSystemRevision(input);assert.deepEqual(readSystemRevision(master),master);assert.equal(JSON.stringify(master).includes('/private/app'),false);
  assert.throws(()=>defineSystemRevision({...input,source:{...input.source,repository:'/private/app'}}));
  assert.throws(()=>defineSystemRevision({...input,source:{...input.source,repository:'source-sha256:malformed'}}));
});
async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const directory=await mkdtemp(join(tmpdir(),'iac-release-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const definition:ReleasePreparationDefinition={id:'v1',label:'Application v1',source:{repository:revision.repository,ref:revision.ref},recipe,
    target:{id:'build-host',scope:'artifact-store'},configurationDigest:'c'.repeat(64)};
  const calls:string[]=[],controls:{fail?:string;mismatch?:string;gate?:Promise<void>}={};const store=new FileReleasePreparationStore(directory);
  const perform=async(id:string)=>{calls.push(id);assert.equal((await store.load())!.stages.find(stage=>stage.id===id)!.status,'running');
    if(controls.fail===id)throw Error('PRIVATE-PASSWORD');if(id==='build'&&controls.gate)await controls.gate;};
  const adapters:Pick<DeliveryAdapters,'source'|'build'|'artifacts'>={
    source:{async resolve(source){await perform('resolve');return{...revision,...source};},async fetch(revision){await perform('fetch');return{revision:{...revision,...(controls.mismatch==='source'?{tree:'9'.repeat(40)}:{})},location:'/private/source/checkout'};}},
    build:{async build(_source,recipe){await perform('build');return{artifacts,recipeDigest:controls.mismatch==='recipe'?'9'.repeat(64):recipe.digest,metadata:{private:'/private/build'}};}},
    artifacts:{async publish(build){await perform('publish');return{artifacts:build.artifacts.map(a=>({...a,...(controls.mismatch==='artifact'?{digest:'9'.repeat(64)}:{})}))};}}};
  const workflow=()=>new ReleasePreparationWorkflow({definition,store,adapters});return{directory,definition,calls,controls,store,adapters,workflow};
}
test('build once has four actual native stages; replay is complete and reopening never repeats adapter effects',async t=>{
  const f=await fixture(t),state=await f.workflow().start();assert.equal(state.status,'passed');assert.deepEqual(f.calls,['resolve','fetch','build','publish']);
  assert.equal(state.release!.source.commit,revision.commit);assert.equal(state.events.length,8);
  const receipt=state.recordings[0]!,evidence=JSON.parse(await readFile(receipt.evidencePath,'utf8'));
  assert.equal(evidence.snapshot.commitLog.length,4);
  const stored=readStoredRecord(readRecordFile(receipt.tracePath).entries).root(receipt.runId)!;
  assert.equal(stored.complete,true);assert.deepEqual(stored.gaps,[]);assert.deepEqual(stateAt(stored,stored.commitLog.length-1).state,evidence.snapshot.sharedState);
  for(const file of [receipt.evidencePath,receipt.tracePath]){const bytes=await readFile(file,'utf8');assert.equal(bytes.includes('/private/source'),false);assert.equal(bytes.includes('/private/build'),false);}
  assert.deepEqual(await f.workflow().start(),state);assert.equal(f.calls.length,4);
  const bad=structuredClone(state);bad.release!.source.commit='9'.repeat(40);await writeFile(f.store.path,JSON.stringify(bad));
  await assert.rejects(()=>f.workflow().snapshot(),/digest changed/);
});
test('build failures and identity substitution stop downstream work and retain sanitized native failures',async t=>{
  for(const fail of ['resolve','fetch','build','publish']){const f=await fixture(t);f.controls.fail=fail;
    const state=await f.workflow().start();assert.equal(state.status,'failed');assert.equal(f.calls.at(-1),fail);assert.equal(state.release,undefined);
    for(const path of [f.store.path,state.recordings[0]!.evidencePath,state.recordings[0]!.tracePath])assert.equal((await readFile(path,'utf8')).includes('PRIVATE-PASSWORD'),false);
    await assert.rejects(()=>f.workflow().start(),/already started/);
  }
  for(const mismatch of ['source','recipe','artifact']){const f=await fixture(t);f.controls.mismatch=mismatch;assert.equal((await f.workflow().start()).status,'failed');}
});
test('immutable build stores reject changed bindings and serialize simultaneous starts',async t=>{
  const f=await fixture(t);let release!:()=>void;f.controls.gate=new Promise<void>(resolve=>{release=resolve;});
  const first=f.workflow().start();while(!f.calls.includes('build'))await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(()=>f.workflow().start(),/lock|running|locked/i);release();const result=await first;
  assert.equal(result.status,'passed');assert.equal(f.calls.filter(id=>id==='build').length,1);
  const changed=new ReleasePreparationWorkflow({definition:{...f.definition,configurationDigest:'d'.repeat(64)},store:f.store,
    adapters:f.adapters});
  await assert.rejects(()=>changed.snapshot(),/binding changed/);
});
test('a catalog selection pins the reviewed commit/tree and refuses moved tags before fetching or building',async t=>{
  const f=await fixture(t);
  const expectedRevision={...revision,commit:'9'.repeat(40)};
  const selected=new ReleasePreparationWorkflow({definition:f.definition,store:f.store,adapters:f.adapters,expectedRevision});
  assert.equal((await selected.start()).status,'failed');assert.deepEqual(f.calls,['resolve']);
  await assert.rejects(()=>new ReleasePreparationWorkflow({definition:f.definition,store:f.store,adapters:f.adapters,expectedRevision:revision}).snapshot(),/binding changed/);
});
test('private artifact handles are refused before they enter native build or publication receipts',async t=>{
  for(const reference of ['/private/package.tgz','C:\\private\\package.zip','file:///private/package.tgz']){
    const f=await fixture(t);f.adapters.build.build=async()=>({recipeDigest:recipe.digest,artifacts:[{...artifacts[0]!,reference}]});
    const state=await f.workflow().start();assert.equal(state.status,'failed');assert.equal(state.stages[2]!.status,'failed');
    assert.equal(f.calls.includes('publish'),false);for(const file of [state.recordings[0]!.tracePath,state.recordings[0]!.evidencePath])assert.equal((await readFile(file,'utf8')).includes(reference),false);
  }
});
