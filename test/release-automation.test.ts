import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ReleaseAutomationHost,FileReleaseAutomationStore,loadReleaseAutomationRecording,projectReleaseAutomationState,type ReleaseAutomationDefinition} from '../src/release-automation/node.ts';
import {ReleasePreparationWorkflow,FileReleasePreparationStore,type ResolvedReleaseChoice} from '../src/releases/node.ts';
import {PipelineWorkflow,FilePipelineStore,FilePipelineTargetStore,directStrategy,type PipelineDefinition,type RolloutAdapter,type PipelineState} from '../src/pipeline/node.ts';
import type {ReleaseCatalog,ReleaseChoice} from '../src/releases/types.ts';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const directory=await mkdtemp(join(tmpdir(),'iac-release-auto-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const repository='https://github.com/acme/app.git',choices:ReleaseChoice[]=[],pins=new Map<string,ResolvedReleaseChoice>();
  const calls:string[]=[],deployed=new Map<string,string>(),controls:{catalogDown?:boolean;badBuild?:boolean;unknownDeploy?:boolean;failStage?:string;manualGamma?:boolean;buildGate?:Promise<void>;entered?:()=>void;movedSource?:boolean}={};
  const store=new FileReleaseAutomationStore(join(directory,'automation')),targetStore=new FilePipelineTargetStore(join(directory,'targets'));
  const definition:ReleaseAutomationDefinition={version:1,id:'app-releases',label:'Published application versions',catalogId:'source',adapterId:'build-and-deploy',configurationDigest:'a'.repeat(64),automatic:{enabled:true,initial:'observe'}};
  function add(version:number,id='release-'+version,commit=String(version).repeat(40)){
    const choice={id,label:'Application v'+version,publishedAt:new Date(Date.UTC(2026,0,version)).toISOString(),source:{repository,ref:'refs/tags/v'+version}};
    choices.push(choice);pins.set(id,{...choice,source:{...choice.source,commit,tree:'b'.repeat(40)}});return id;
  }
  const catalog:ReleaseCatalog={id:'source',async list(){calls.push('list');if(controls.catalogDown)throw Error('PRIVATE-TOKEN');return structuredClone(choices);},async resolve(id){calls.push('resolve:'+id);const value=structuredClone(pins.get(id)!);if(controls.movedSource)value.source.ref='refs/tags/moved';return value;}};
  const rollout:RolloutAdapter={id:'test-host',label:'Explicit simulated provider',capabilities:['deploy'],async execute(_action,release,context){calls.push('deploy:'+context.stageId);if(controls.unknownDeploy)throw Error('PRIVATE-PROVIDER');deployed.set(context.target.scope,release.digest);return{status:'succeeded',metadata:{secret:'PRIVATE-PROVIDER'},changes:[{resourceId:'app',action:'update'}]};},async observe(context){return{known:true,releaseDigest:deployed.get(context.target.scope)??null};}};
  const adapter={id:'build-and-deploy',async prepare(choice:ResolvedReleaseChoice,context:{attemptId:string;directory:string}){
    calls.push('prepare-factory');assert.equal((await store.load())!.attempts.find(attempt=>attempt.id===context.attemptId)!.status,'preparing');
    return new ReleasePreparationWorkflow({definition:{id:context.attemptId,label:choice.label,source:{repository:choice.source.repository,ref:choice.source.ref},target:{id:'artifact-host',scope:'simulated/artifacts'},recipe:{id:'app',digest:'c'.repeat(64)},configurationDigest:definition.configurationDigest},expectedRevision:choice.source,store:new FileReleasePreparationStore(join(context.directory,'build')),
      adapters:{source:{async resolve(){calls.push('build-resolve');return choice.source;},async fetch(revision){calls.push('fetch');return{revision,location:'/private/checkout'};}},build:{async build(_source,recipe){calls.push('build');controls.entered?.();if(controls.buildGate)await controls.buildGate;if(controls.badBuild)throw Error('PRIVATE-BUILD');return{recipeDigest:recipe.digest,artifacts:[{id:'app',digest:choice.source.commit.slice(0,1).repeat(64),reference:'registry/app:'+choice.id}],metadata:{path:'/private/build'}};}},artifacts:{async publish(build){calls.push('publish');return{artifacts:build.artifacts};}}}});
  },async pipeline(prepared:Parameters<import('../src/release-automation/types.ts').ReleaseAutomationAdapter['pipeline']>[0],context:{directory:string}){
    calls.push('pipeline-factory');const pipelineDefinition:PipelineDefinition={version:1,id:'app-pipeline',label:'Three environments',configurationDigest:definition.configurationDigest,stages:['dev','gamma','prod'].map(id=>({id,label:id,target:{id:'app-'+id,scope:'simulated/'+id},adapterId:rollout.id,strategyId:'direct',promotion:id==='gamma'&&controls.manualGamma?'manual':'automatic',rollback:'disabled',checks:[{runnerId:'acceptance',suiteId:'access',suiteDigest:'d'.repeat(64)}]}))};
    return new PipelineWorkflow({definition:pipelineDefinition,release:prepared.release!,store:new FilePipelineStore(join(context.directory,'pipeline')),targetStore,registry:{strategies:[directStrategy()],adapters:[rollout],checks:[{id:'acceptance',suites:()=>[{id:'access',label:'App access',digest:'d'.repeat(64),kind:'explicit-contract'}],async run(request){const passed=request.stageId!==controls.failStage;return{request,status:passed?'passed':'failed',checks:[{id:'access',status:passed?'passed':'failed'}]};}}]}});
  }};
  const host=()=>new ReleaseAutomationHost({definition,catalog,adapter,store});return{directory,definition,choices,pins,calls,controls,store,add,host};
}

test('initial poll observes backlog; a new source is built once and crosses dev gamma prod, then restart and repeated ticks do not redeploy',async t=>{
  const f=await fixture(t);f.add(1);const host=f.host();assert.equal((await host.tick()).attempts.length,0);assert.deepEqual(f.calls,['list']);
  f.add(2);const updates:string[]=[];host.subscribe(state=>{updates.push(state.attempts.at(-1)?.status??'none');});const done=await host.tick();assert.equal(done.attempts[0]!.status,'passed');
  assert.deepEqual(f.calls.filter(call=>call.startsWith('deploy:')),['deploy:dev','deploy:gamma','deploy:prod']);assert.equal(f.calls.filter(call=>call==='build').length,1);
  assert.ok(updates.includes('preparing'));assert.ok(updates.includes('deploying'));
  assert.equal((await f.host().snapshot()).attempts[0]!.status,'passed');await f.host().tick();await f.host().start('release-2');assert.equal(f.calls.filter(call=>call==='build').length,1);
  const publicState=JSON.stringify(projectReleaseAutomationState(done));assert.equal(publicState.includes('/private'),false);assert.equal(publicState.includes(f.directory),false);assert.equal(publicState.includes('PRIVATE-'),false);
  for(const receipt of done.recordings){const loaded=await loadReleaseAutomationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:done.definitionDigest});assert.equal(loaded.complete,true);for(const path of [receipt.evidencePath,receipt.tracePath])assert.equal((await readFile(path,'utf8')).includes('/private'),false);}
});
test('refresh never deploys; manual registered IDs work with automation disabled and source aliases dedupe by immutable content',async t=>{
  const f=await fixture(t);f.definition.automatic.enabled=false;f.add(1);const host=f.host();const state=await host.refresh();assert.equal(state.attempts.length,0);assert.equal(f.calls.includes('build'),false);
  assert.throws(()=>host.start('https://evil.example/ref'),/identifier/);await assert.rejects(()=>host.start('not-listed'),/discovered/);
  const done=await host.start('release-1');assert.equal(done.attempts[0]!.trigger,'manual');assert.equal(done.attempts[0]!.status,'passed');
  f.add(2,'same-code','1'.repeat(40));await host.refresh();const duplicate=await host.start('same-code');assert.equal(duplicate.attempts[1]!.status,'skipped');assert.equal(duplicate.attempts[1]!.reason,'source-already-attempted');assert.equal(f.calls.filter(call=>call==='build').length,1);
});
test('a manual gamma gate survives host restart; exact approval continues without rebuild and suppresses newer automatic releases while waiting',async t=>{
  const f=await fixture(t);f.controls.manualGamma=true;f.add(1);await f.host().tick();f.add(2);const waiting=await f.host().tick(),attempt=waiting.attempts[0]!;assert.equal(attempt.status,'waiting');assert.equal(attempt.pipeline!.pendingAction!.stageId,'gamma');
  f.add(3);assert.equal((await f.host().tick()).attempts.length,1);assert.equal(f.calls.filter(call=>call==='build').length,1);
  const {kind:_,...request}=attempt.pipeline!.pendingAction!;await assert.rejects(()=>f.host().promote(attempt.id,{...request,token:'wrong'}),/gate changed/);
  const done=await f.host().promote(attempt.id,request);assert.equal(done.attempts[0]!.status,'passed');assert.deepEqual(f.calls.filter(call=>call.startsWith('deploy:')),['deploy:dev','deploy:gamma','deploy:prod']);assert.equal(f.calls.filter(call=>call==='build').length,1);
  await assert.rejects(()=>f.host().promote(attempt.id,request),/outstanding/);
  assert.equal((await f.host().tick()).attempts.length,2,'newer source remains eligible after the gate');
});
test('failed build and failed stage are retained; automatic deployment stops, no blind retries or downstream stage execution occur',async t=>{
  for(const failure of ['build','gamma']){const f=await fixture(t);f.add(1);await f.host().tick();if(failure==='build')f.controls.badBuild=true;else f.controls.failStage='gamma';f.add(2);
    const failed=await f.host().tick();assert.equal(failed.attempts[0]!.status,'failed');if(failure==='build')assert.equal(f.calls.includes('pipeline-factory'),false);else assert.deepEqual(f.calls.filter(call=>call.startsWith('deploy:')),['deploy:dev','deploy:gamma']);
    f.add(3);await f.host().tick();await f.host().start('release-2');assert.equal(f.calls.filter(call=>call==='build').length,1);assert.equal((await f.host().snapshot()).attempts.length,1);
    const report=JSON.stringify(projectReleaseAutomationState(failed));assert.equal(report.includes('PRIVATE-'),false);
  }
});
test('unknown provider effects remain incomplete and block future automatic and manual work without replay',async t=>{
  const f=await fixture(t);f.add(1);await f.host().tick();f.controls.unknownDeploy=true;f.add(2);const state=await f.host().tick();assert.equal(state.attempts[0]!.status,'incomplete');assert.deepEqual(f.calls.filter(call=>call.startsWith('deploy:')),['deploy:dev']);
  f.controls.unknownDeploy=false;f.add(3);await f.host().tick();await assert.rejects(()=>f.host().start('release-3'),/uncertain/);assert.equal(f.calls.filter(call=>call==='build').length,1);
});
test('moved source selectors fail before a build',async t=>{
  const f=await fixture(t);f.add(1);await f.host().refresh();f.controls.movedSource=true;const result=await f.host().start('release-1');assert.equal(result.attempts[0]!.status,'failed');assert.equal(result.attempts[0]!.reason,'source-resolution-unconfirmed');assert.equal(f.calls.includes('prepare-factory'),false);
});
test('concurrent host calls do not overlap a build and the same live host exposes truthful progress',async t=>{
  const f=await fixture(t);f.add(1);const host=f.host();await host.refresh();let release!:()=>void,entered!:()=>void;f.controls.buildGate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});f.controls.entered=entered;
  const run=host.start('release-1');await started;assert.equal((await host.snapshot()).attempts[0]!.status,'preparing');
  await assert.rejects(()=>f.host().start('release-1'),/lock/i);release();assert.equal((await run).attempts[0]!.status,'passed');assert.equal(f.calls.filter(call=>call==='build').length,1);
});
test('interrupted intent is visible as uncertain after reopening, without restarting tools; changed policy and native tampering are rejected',async t=>{
  const f=await fixture(t);f.add(1);await f.host().refresh();const initial=await f.store.load();initial!.attempts.push({id:'interrupted',releaseId:'release-1',trigger:'manual',status:'preparing',createdAt:1,recordings:[]});await f.store.save(initial!);
  assert.equal((await f.host().snapshot()).attempts[0]!.status,'incomplete');await f.host().tick();assert.equal(f.calls.includes('build'),false);
  const other=await fixture(t);other.add(1);await other.host().refresh();other.definition.automatic.enabled=false;await assert.rejects(()=>other.host().snapshot(),/policy changed/);
  const safe=await fixture(t);safe.add(1);const state=await safe.host().refresh(),receipt=state.recordings[0]!,body=JSON.parse(await readFile(receipt.evidencePath,'utf8'));body.snapshot.sharedState.discovery.choices[0].label='forged';await writeFile(receipt.evidencePath,JSON.stringify(body));await assert.rejects(()=>safe.host().snapshot(),/replay changed/);
});
test('catalog unavailability keeps previous choices visibly stale and never triggers a build; latest backlog requires explicit policy',async t=>{
  const f=await fixture(t);f.add(1);await f.host().refresh();f.controls.catalogDown=true;assert.equal((await f.host().tick()).discoveryStatus,'unavailable');await assert.rejects(()=>f.host().start('release-1'),/Refresh/);assert.equal(f.calls.includes('build'),false);
  const next=await fixture(t);next.definition.automatic.initial='latest';next.add(1);next.add(2);const result=await next.host().tick();assert.equal(result.attempts[0]!.releaseId,'release-2');assert.equal(result.attempts[0]!.status,'passed');
});
test('forged successful jobs cannot bypass missing build, pipeline and coordinator evidence',async t=>{
  const f=await fixture(t);f.add(1);await f.host().refresh();const initial=(await f.store.load())!;initial.attempts.push({id:'forged',releaseId:'release-1',trigger:'manual',status:'passed',createdAt:1,recordings:[]});await f.store.save(initial);
  await assert.rejects(()=>f.host().snapshot(),/verified children/);assert.equal(f.calls.includes('build'),false);
});
