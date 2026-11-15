import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { FileStateStore, InfraEngine, ReconcileStrategy, SimulatorAdapter, type ResourceAdapter } from '../src/index.ts';
import { createDeploymentRecorder } from '../src/progress/index.ts';
import { defineReleaseManifest } from '../src/releases/manifest.ts';
import { createIdentityGraph } from '../integration/identity/graph.ts';
import { neoDeliveryArtifacts, neoDeliveryHash, neoDeliveryTarget } from '../integration/identity/github-delivery/target.ts';
import { createNeoReleasePipeline, createNeoReleasePreparation, bindNeoReleaseCandidate, observeNeoRelease, neoImageConfigDigest, type NeoPreparedRelease } from '../integration/identity/release-pipeline/index.ts';
import { writeNeoFlowJson } from '../integration/identity/resource-flow-files.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { canonical, fingerprint } from '../src/util.ts';
import {kubernetesAssessmentAddress} from '../src/change-assessment/kubernetes-manifest.ts';
import type {KubernetesAssessmentTransport} from '../src/change-assessment/kubernetes.ts';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'neo-release-pipeline-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const id='a1b2c3d4',fixtureRoot=join(root,'.artifacts/identity'),directory=join(fixtureRoot,id);
  const target:IdentityTarget={version:1,id,directory,stateDirectory:join(directory,'state'),context:'kind-footprint-iac-recording-b1b2c3d4',
    kubeconfig:join(root,'.artifacts/neo/fresh/b1b2c3d4/kubeconfig'),namespace:'footprint-iac-identity-'+id,neoPort:61660,providerPort:61661,ldapPort:61662,
    issuer:'http://127.0.0.1:61661/realms/neo',providerName:'footprint-identity-'+id+'-provider',directoryName:'footprint-identity-'+id+'-directory',fixtureDigest:'f'.repeat(64),
    sourceCommit:'1'.repeat(40),images:{nodeImage:'footprint-iac/neo-node:identity-'+'1'.repeat(64),pythonImage:'footprint-iac/neo-python:identity-'+'2'.repeat(64),ldapImage:'sha256:'+'3'.repeat(64),providerImage:'sha256:'+'4'.repeat(64)}};
  const targetPath=join(directory,'target.json');await writeNeoFlowJson(targetPath,target);await writeNeoFlowJson(join(fixtureRoot,'latest.json'),target);
  const loadTarget=async(path?:string)=>JSON.parse(await readFile(path??targetPath,'utf8')) as IdentityTarget;
  const simulator=new SimulatorAdapter({file:join(root,'provider.json')});let deployed=structuredClone(target),owner=true,ready=true,runtimeCorrect=true,accept=true;
  let assessmentMode:'ok'|'immutable'|'permission'|'conflict'|'unavailable'|'drift'='ok',assessmentAttempt=0;
  const assessmentRequests:{method:string;path:string}[]=[];
  const assessmentTransport=async():Promise<KubernetesAssessmentTransport>=>{
    const attempt=++assessmentAttempt;
    return{async request(method,path,body){
      assessmentRequests.push({method,path});
      const url=new URL(path,'https://fixture.invalid');
      const resource=createIdentityGraph(deployed,{includeNeo:true}).resources.find(resource=>resource.provider==='kubernetes'&&kubernetesAssessmentAddress(resource,target.namespace).path===url.pathname);
      if(!resource)return{status:404,body:{kind:'Status',reason:'NotFound'}};
      const live=structuredClone(resource.spec),metadata=live.metadata as Record<string,unknown>;
      live.metadata={...metadata,uid:'uid-'+resource.id,resourceVersion:assessmentMode==='drift'&&attempt>1?'2':'1',generation:1,
        annotations:{'footprint-iac.dev/owner':fingerprint({stack:graph.name,id:resource.id}),'footprint-iac.dev/stack':graph.name,'footprint-iac.dev/resource':resource.id},
        managedFields:[{manager:'footprint-iac',operation:'Update',apiVersion:String(live.apiVersion),fieldsType:'FieldsV1',fieldsV1:{'f:spec':{'.':{}}}}]};
      live.status=live.kind==='Namespace'?{phase:'Active'}:live.kind==='Deployment'?{observedGeneration:1,updatedReplicas:1,availableReplicas:1,replicas:1}:{};
      if(method==='GET'){if(assessmentMode==='unavailable')throw Error('Simulated API unavailable');return{status:200,body:live};}
      assert.equal(url.searchParams.get('dryRun'),'All','preflight never persists provider writes');
      if(assessmentMode==='permission')return{status:403,body:{kind:'Status',reason:'Forbidden'}};
      if(assessmentMode==='conflict')return{status:409,body:{kind:'Status',reason:'Conflict'}};
      if(assessmentMode==='immutable')return{status:422,body:{kind:'Status',status:'Failure',code:422,reason:'Invalid',details:{name:metadata.name,kind:'Deployment',
        causes:[{reason:'FieldValueInvalid',field:'spec.selector',message:'field is immutable'}]}}};
      return{status:200,body};
    }};
  };
  const adapter=(name:string):ResourceAdapter=>({name,scope:simulator.scope+'/'+name,supportsSafeRetry:true,observe:simulator.observe.bind(simulator),
    async apply(resource,context){await simulator.apply(resource,context);if(resource.id==='neo-app'){
      const containers=(((resource.spec.spec as Record<string,unknown>).template as Record<string,unknown>).spec as Record<string,unknown>).containers as {name:string;image:string}[];
      deployed={...deployed,images:{...deployed.images,nodeImage:containers.find(item=>item.name==='node')!.image,pythonImage:containers.find(item=>item.name==='python')!.image}};
    }},remove:simulator.remove.bind(simulator),waitReady:simulator.waitReady.bind(simulator)});
  const engineFactory:typeof import('../integration/identity/engine.ts').identityEngine=selected=>{
    const recorder=createDeploymentRecorder();return {recorder,engine:new InfraEngine({adapters:[adapter('local-identity-fixture'),adapter('kubernetes')],store:new FileStateStore(selected.stateDirectory),
      strategy:new ReconcileStrategy(1),traceDirectory:join(directory,'deployment-traces'),recorders:[recorder],chartObservers:[recorder]})};
  };
  const baseline=engineFactory(target),graph=createIdentityGraph(target,{includeNeo:true}),result=await baseline.engine.apply(graph);assert.equal(result.ok,true);
  await writeNeoFlowJson(join(directory,'deployment.json'),{graph,result,events:baseline.recorder.getEvents()});simulator.calls.length=0;
  const containers=()=>[{name:'node',image:deployed.images.nodeImage},{name:'python',image:deployed.images.pythonImage}];
  const configs=new Map<string,string>(),configFor=(reference:string)=>{let value=configs.get(reference);if(!value){value=JSON.stringify({architecture:'arm64',rootfs:{type:'layers',diff_ids:[reference]},config:{Cmd:['node']}})+'\n';configs.set(reference,value);}return value;};
  const calls:{program:string;args:string[]}[]=[];
  const runner=async(program:string,args:string[])=>{
    calls.push({program,args:[...args]});
    if(program==='kubectl'){
      if(args.includes('deployment'))return JSON.stringify({metadata:{name:'neo',namespace:target.namespace,uid:'deployment-uid',generation:2,annotations:{'footprint-iac.dev/owner':owner?fingerprint({stack:graph.name,id:'neo-app'}):'other'}},
        spec:{replicas:1,selector:{matchLabels:{'app.kubernetes.io/instance':target.namespace}},template:{spec:{containers:containers()}}},status:{observedGeneration:2,readyReplicas:ready?1:0,updatedReplicas:1,availableReplicas:ready?1:0}});
      if(args.includes('replicasets'))return JSON.stringify({items:[{metadata:{namespace:target.namespace,uid:'rs-uid',ownerReferences:[{kind:'Deployment',uid:'deployment-uid',controller:true}]}}]});
      if(args.includes('pods'))return JSON.stringify({items:[{metadata:{name:'neo-pod',namespace:target.namespace,uid:'pod-uid',ownerReferences:[{kind:'ReplicaSet',uid:'rs-uid',controller:true}]},spec:{containers:containers()},
        status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:containers().map(container=>({...container,image:container.image+'-runtime-alias',imageID:'sha256:'+digest(configFor(container.image)),ready:true,state:{running:{}}}))}}]});
    }
    if(program==='docker'&&args[0]==='image'&&args[1]==='inspect')return 'sha256:'+args.at(-1)!.split('identity-')[1];
    if(program==='docker'&&args[0]==='image'&&args[1]==='save')return '';
    if(program==='docker'&&args[0]==='exec'){
      const reference=args.at(-1)!;return JSON.stringify({status:{id:'sha256:'+(runtimeCorrect?digest(configFor(reference)):'0'.repeat(64)),repoTags:[reference,reference+'-runtime-alias'],repoDigests:[]}});
    }
    if(program==='tar'){
      const reference=calls.findLast(call=>call.program==='docker'&&call.args[0]==='image'&&call.args[1]==='save')!.args.at(-1)!;
      if(args.at(-1)==='manifest.json')return JSON.stringify([{Config:'blobs/sha256/'+digest(configFor(reference)),RepoTags:[reference]}]);
      if(args[0]==='-xf'){const destination=join(args[args.indexOf('-C')+1]!,args.at(-1)!);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,configFor(reference));return '';}
      throw Error('Unexpected tar fixture command');
    }
    if(program==='kind')return '';throw Error('Unexpected fixture command');
  };
  const release=async(name:string,node:string,python:string,commit:string,tree:string):Promise<NeoPreparedRelease>=>{
    const staged={...target,sourceCommit:commit,images:{...target.images,nodeImage:'footprint-iac/neo-node:identity-'+node.repeat(64),pythonImage:'footprint-iac/neo-python:identity-'+python.repeat(64)}};
    const path=join(directory,'candidates','prepared-'+name,tree,'target.json');await writeNeoFlowJson(path,staged);
    await writeNeoFlowJson(join(dirname(path),'source-review.json'),{baseCommit:commit,sourceTree:tree,imageId:'sha256:'+node.repeat(64),image:staged.images.nodeImage,
      pythonImageId:'sha256:'+python.repeat(64),pythonImage:staged.images.pythonImage,canonicalTargetSha256:neoDeliveryHash(await readFile(targetPath,'utf8')),candidateScope:'prepared-'+name});
    const manifest=defineReleaseManifest({id:name,label:name,source:{repository:'https://github.com/company/neo',ref:name,commit,tree},recipe:{id:'neo-images',digest:'e'.repeat(64)},artifacts:neoDeliveryArtifacts(staged)});
    return {manifest,publication:{artifacts:[...manifest.artifacts],metadata:{candidatePath:path,repository:manifest.source.repository,commit,tree}},buildTargetPath:targetPath};
  };
  const v1=await release('v1','1','2','1'.repeat(40),'3'.repeat(40)),v2=await release('v2','5','6','7'.repeat(40),'8'.repeat(40));
  const checks={connections:async()=>({async check(request:import('../src/connections/types.ts').ConnectionCheckRequest){if(!accept)throw Error('unavailable');return {method:'fixture-transport',target:request.connectionId,observedAt:Date.now(),latencyMs:1,details:{status:200}};}}),
    identity:async()=>({id:'fixture-access',async check(request:import('../src/identity/types.ts').IdentityCheckRequest){return {verdict:accept?request.expected:'unavailable' as const,observedAt:Date.now(),latencyMs:1};}})};
  return {root,directory,target,targetPath,loadTarget,runner,calls,v1,v2,simulator,engineFactory,fixtureRoot,checks,assessmentTransport,assessmentRequests,
    setAssessment:(value:typeof assessmentMode)=>{assessmentMode=value;assessmentAttempt=0;assessmentRequests.length=0;},
    setOwner:(value:boolean)=>{owner=value;},setReady:(value:boolean)=>{ready=value;},setRuntime:(value:boolean)=>{runtimeCorrect=value;},setAccept:(value:boolean)=>{accept=value;},
    create:()=>createNeoReleasePipeline({environments:[{id:'local',label:'Local acceptance',targetPath,promotion:'automatic',rollback:'disabled'}],releases:[v1,v2],loadTarget,runner,fixtureRoot,engineFactory,checks,assessmentTransport,restoreForward:async()=>{}})};
}

test('Neo composes direct generic pipelines, updates only app artifacts, records full access checks and reuses immutable releases without rebuilding',async t=>{
  const f=await fixture(t),consumer=await f.create(),seen:string[]=[],assessments:import('../integration/identity/github-delivery/types.ts').NeoDeliveryObservation[]=[];
  consumer.subscribe(event=>{seen.push(event.kind);if(event.kind==='assessment'&&event.report&&event.recording)assessments.push(event);});
  assert.deepEqual(consumer.listReleases().map(release=>release.id),['v1','v2']);assert.deepEqual(consumer.registry.adapters.map(adapter=>adapter.capabilities),[['deploy']]);
  const prepared=await consumer.createPipeline({id:'v2-attempt',releaseId:'v2'}),v2=await prepared.workflow.start();assert.equal(v2.status,'passed');
  assert.deepEqual(f.simulator.calls.map(call=>call.id),['neo-app']);
  const checks=v2.stages[0]!.operations.filter(operation=>operation.check).flatMap(operation=>operation.check!.checks);assert.equal(checks.length,10);assert.ok(checks.every(check=>check.status==='passed'));
  assert.ok(seen.includes('assessment')&&seen.includes('plan')&&seen.includes('deployment')&&seen.includes('connections')&&seen.includes('identity')&&seen.includes('applied'));
  const linked=v2.stages[0]!.operations.find(operation=>operation.id==='deploy')!.receipt!.evidence!;
  assert.equal(linked.length,2);assert.deepEqual(linked.map(item=>item.kind),['change-assessment-plan','change-assessment-revalidate']);
  assert.ok(linked.every(link=>assessments.some(event=>event.kind==='assessment'&&event.report?.digest===link.digest&&event.recording?.runId===link.runId)));
  const native=JSON.parse(await readFile(v2.recordings[0]!.evidencePath,'utf8'));
  assert.deepEqual(native.snapshot.sharedState['operation:deploy'].receipt.evidence,linked,'native pipeline binds both independent assessment captures');
  assert.equal(JSON.stringify(native.snapshot.sharedState).includes(f.root),false,'private host/credential paths remain outside native scope summaries');
  assert.equal((await f.loadTarget()).sourceCommit,f.v2.manifest.source.commit);
  const firstDigest=v2.release.digest;
  const back=await consumer.createPipeline({id:'v1-again',releaseId:'v1'}),v1=await back.workflow.start();assert.equal(v1.status,'passed');assert.equal(v1.release.digest,f.v1.manifest.digest);
  const again=await consumer.createPipeline({id:'v2-again',releaseId:'v2'});assert.equal((await again.workflow.start()).status,'passed');assert.equal((await again.workflow.snapshot()).release.digest,firstDigest);
  assert.deepEqual(f.simulator.calls.map(call=>call.id),['neo-app','neo-app','neo-app']);
  assert.equal(f.calls.some(call=>call.program==='docker'&&call.args[0]==='build'),false,'prepared promotion does not rebuild');
  assert.deepEqual(await prepared.workflow.start(),v2,'reopening a completed attempt never reapplies it');
});

test('Neo actual release observation rejects ownership/readiness/runtime drift and ambiguous manifest identities',async t=>{
  const f=await fixture(t),manifests=[f.v1.manifest,f.v2.manifest];
  assert.deepEqual(await observeNeoRelease(f.target,manifests,f.runner),{known:true,releaseDigest:f.v1.manifest.digest});
  for(const set of [f.setOwner,f.setReady,f.setRuntime]){set(false);assert.equal((await observeNeoRelease(f.target,manifests,f.runner)).known,false);set(true);}
  const sameBytes=defineReleaseManifest({id:'different-release',label:'Different release',source:f.v1.manifest.source,recipe:f.v1.manifest.recipe,artifacts:f.v1.manifest.artifacts});
  assert.equal((await observeNeoRelease(f.target,[...manifests,sameBytes],f.runner)).known,false);
  assert.equal((await observeNeoRelease({...f.target,images:f.v2.manifest.artifacts as never},manifests,f.runner)).releaseDigest,f.v1.manifest.digest,'canonical desired image fields do not decide actual version');
});

test('Neo keeps failed access evidence, disables unsupported restore and refuses substituted source/artifact receipts before provider changes',async t=>{
  const f=await fixture(t),consumer=await f.create();f.setAccept(false);
  const attempted=await consumer.createPipeline({id:'denied-release',releaseId:'v2'}),result=await attempted.workflow.start();assert.equal(result.status,'failed');
  assert.ok(result.stages[0]!.operations.some(operation=>operation.check?.status==='failed'));
  assert.equal(f.simulator.calls.length,1);assert.equal(result.stages[0]!.baseline,undefined);
  await assert.rejects(()=>attempted.workflow.recover({stageId:'local',releaseDigest:result.release.digest,token:'forged'}),/pending action/);
  const fresh=await fixture(t);const bad=structuredClone(fresh.v2);bad.publication.metadata!.tree='9'.repeat(40);
  await assert.rejects(()=>bindNeoReleaseCandidate(bad,fresh.target,fresh.target,'bad-op',fresh.runner),/publication differs/);assert.equal(fresh.simulator.calls.length,0);
  const artifact=fresh.v2.manifest.artifacts[0]!,config=await neoImageConfigDigest(artifact,{directory:join(fresh.directory,'attest'),runner:fresh.runner});assert.match(config,/^sha256:[a-f0-9]{64}$/);
  assert.equal((await readFile(join(fresh.directory,'attest',artifact.digest+'.json'),'utf8')).includes('configDigest'),true);
});

test('Neo build-only preparation retains the reviewed catalog source pin and rejects a moved ref before fetch or build',async t=>{
  const f=await fixture(t),expectedRevision=f.v2.manifest.source;let fetched=0,built=0;
  const preparation=await createNeoReleasePreparation({id:'pinned-build',targetPath:f.targetPath,loadTarget:f.loadTarget,
    source:{repository:expectedRevision.repository,ref:expectedRevision.ref},expectedRevision,
    sourceAdapter:{async resolve(){return {...expectedRevision,commit:'9'.repeat(40)};},async fetch(){fetched++;throw Error('Should not fetch');}},
    buildImages:async()=>{built++;throw Error('Should not build');}});
  const result=await preparation.workflow.start();assert.equal(result.status,'failed');assert.equal(fetched,0);assert.equal(built,0);
  await assert.rejects(()=>preparation.prepared(),/must finish/);
});

test('Neo promotes a host-local source with an opaque public identity while private publication handles remain private',async t=>{
  const f=await fixture(t),repository=join(f.root,'private-onprem-git');
  const local=(item:NeoPreparedRelease):NeoPreparedRelease=>({
    manifest:defineReleaseManifest({id:item.manifest.id,label:item.manifest.label,source:{...item.manifest.source,repository},recipe:item.manifest.recipe,artifacts:item.manifest.artifacts}),
    publication:{...item.publication,metadata:{...item.publication.metadata,repository}},buildTargetPath:item.buildTargetPath,
  });
  const releases=[local(f.v1),local(f.v2)];assert.match(releases[0]!.manifest.source.repository,/^source-sha256:[a-f0-9]{64}$/);
  const consumer=await createNeoReleasePipeline({environments:[{id:'local',label:'On-prem acceptance',targetPath:f.targetPath,promotion:'automatic',rollback:'disabled'}],
    releases,loadTarget:f.loadTarget,runner:f.runner,fixtureRoot:f.fixtureRoot,engineFactory:f.engineFactory,checks:f.checks,assessmentTransport:f.assessmentTransport,restoreForward:async()=>{}});
  const prepared=await consumer.createPipeline({id:'onprem-v2',releaseId:'v2'}),state=await prepared.workflow.start();assert.equal(state.status,'passed');
  assert.equal(state.release.source.repository,releases[1]!.manifest.source.repository);
  for(const receipt of state.recordings)for(const path of [receipt.evidencePath,receipt.tracePath])assert.equal((await readFile(path,'utf8')).includes(repository),false);
});

test('Neo automatically records provider preflight and revalidation; blocked/unknown/replacement never become app mutations',async t=>{
  for(const mode of ['immutable','permission','conflict','unavailable','drift'] as const){
    const f=await fixture(t),consumer=await f.create(),events:import('../integration/identity/github-delivery/types.ts').NeoDeliveryObservation[]=[];
    const baseline=await consumer.createPipeline({id:'verify-baseline-'+mode,releaseId:'v1'});
    assert.equal((await baseline.workflow.start()).status,'passed','establish the actual current release as a checked pipeline baseline');
    consumer.subscribe(event=>events.push(event));f.setAssessment(mode);
    const prepared=await consumer.createPipeline({id:'preflight-'+mode,releaseId:'v2'}),result=await prepared.workflow.start();
    assert.equal(result.status,'failed',mode);assert.equal(f.simulator.calls.length,0,'preflight must refuse '+mode+' before every provider apply');
    assert.equal((await f.loadTarget()).sourceCommit,f.v1.manifest.source.commit,'canonical source is unchanged');
    const assessments=events.filter(event=>event.kind==='assessment');assert.ok(assessments.length,mode);
    const complete=assessments.filter(event=>event.report);assert.ok(complete.length,mode);
    const report=complete.at(-1)!.report!;
    const links=result.stages[0]!.operations.find(operation=>operation.id==='deploy')!.receipt!.evidence!;
    assert.ok(links.some(link=>link.digest===report.digest),'failed native action still links the report explaining refusal');
    const native=JSON.parse(await readFile(result.recordings[0]!.evidencePath,'utf8'));
    assert.deepEqual(native.snapshot.sharedState['operation:deploy'].receipt.evidence,links);
    if(mode==='drift'){
      assert.equal(complete.at(-1)!.phase,'revalidate');
      assert.equal(report.changes.find(change=>change.resourceId==='neo-app')!.disposition,'update');
      assert.ok(complete.some(event=>event.phase==='plan'),'reviewed source revision was recorded');
    }else{
      const decision=report.changes.find(change=>change.resourceId==='neo-app')!;
      assert.equal(decision.disposition,mode==='immutable'?'replace':mode==='permission'?'blocked':'unknown');
      assert.equal(complete.at(-1)!.status,'blocked');
    }
    const patches=f.assessmentRequests.filter(request=>request.method==='PATCH');
    assert.ok(patches.every(request=>new URL(request.path,'https://fixture.invalid').searchParams.get('dryRun')==='All'));
    if(mode==='conflict')assert.equal(patches.length,1,'conflicts do not select a fallback validation request');
  }
});
