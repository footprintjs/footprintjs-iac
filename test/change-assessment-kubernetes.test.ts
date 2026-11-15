import assert from 'node:assert/strict';
import test from 'node:test';
import {fingerprint} from '../src/util.ts';
import {conservativeChangeStrategy} from '../src/change-assessment/strategy.ts';
import {projectAssessedChange} from '../src/change-assessment/project.ts';
import {KubernetesChangeAssessmentAdapter,createHttpsKubernetesAssessmentTransport,mergePatchValidation} from '../src/change-assessment/kubernetes.ts';
import type {KubernetesUpdateValidationStrategy} from '../src/change-assessment/kubernetes.ts';
import type {KubernetesAssessmentResponse} from '../src/change-assessment/kubernetes.ts';
import type {ResourceChange} from '../src/change-assessment/types.ts';
import type {JsonObject,Resource} from '../src/types.ts';

function fixture(strategy?:KubernetesUpdateValidationStrategy){
  const resource:Resource={id:'app',provider:'kubernetes',spec:{apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'app',namespace:'owned-review'},spec:{replicas:1,
    selector:{matchLabels:{app:'app'}},template:{metadata:{labels:{app:'app'}},spec:{containers:[{name:'app',image:'app:v1'}]}}}}};
  const live:Record<string,unknown>={...structuredClone(resource.spec),metadata:{...resource.spec.metadata as JsonObject,uid:'actual-uid',resourceVersion:'17',generation:1,
    annotations:{'footprint-iac.dev/owner':fingerprint({stack:'review',id:'app'}),'footprint-iac.dev/stack':'review','footprint-iac.dev/resource':'app'}},status:{observedGeneration:1,replicas:1,updatedReplicas:1,availableReplicas:1}};
  const calls:{method:string;path:string;body?:unknown;contentType?:string}[]=[],controls:{validation?:KubernetesAssessmentResponse;changeAfterValidation?:boolean;notFound?:boolean}={};
  const adapter=new KubernetesChangeAssessmentAdapter({id:'kubernetes-server',scope:'selected-cluster',stack:'review',namespace:'owned-review',validationStrategy:strategy,transport:{async request(method,path,body,settings){
    calls.push({method,path,...(body?{body}:{}),...(settings?.contentType?{contentType:settings.contentType}:{})});
    if(method==='GET')return{status:controls.notFound?404:200,body:controls.notFound?{kind:'Status'}:structuredClone(live)};
    assert.equal(new URL(path,'https://local.invalid').searchParams.get('dryRun'),'All');assert.equal(new URL(path,'https://local.invalid').searchParams.get('fieldValidation'),'Strict');
    if(controls.changeAfterValidation)(live.metadata as Record<string,unknown>).resourceVersion='18';
    return controls.validation??{status:200,body:body};
  }}});
  const change:ResourceChange={id:'app-update',label:'Application',adapterId:adapter.id,strategyId:'conservative',data:'stateless',previous:resource,
    desired:{...resource,spec:{...resource.spec,spec:{...resource.spec.spec as JsonObject,replicas:2}}}};
  const context={executionId:'execution',operationId:'operation',definitionDigest:'a'.repeat(64),target:{id:'local',scope:adapter.scope}};
  return{resource,live,calls,controls,adapter,change,context,async decision(){return projectAssessedChange(change,await adapter.probe(change,context),conservativeChangeStrategy());}};
}
test('Kubernetes assessment reads actual ownership, validates through dry-run All with UID/version and never persists a mutation',async()=>{
  const f=fixture(),decision=await f.decision();assert.equal(decision.disposition,'update');assert.equal(decision.validation,'provider-dry-run');
  assert.deepEqual(f.calls.map(call=>call.method),['GET','PATCH','GET']);const body=f.calls[1]!.body as {metadata:Record<string,string>};
  assert.equal(body.metadata.uid,'actual-uid');assert.equal(body.metadata.resourceVersion,'17');assert.equal((f.live.metadata as {resourceVersion:string}).resourceVersion,'17');
  assert.ok(f.calls.every(call=>call.method==='GET'||call.path.includes('dryRun=All')));
  f.calls.length=0;f.change.desired=f.resource;assert.equal((await f.decision()).disposition,'noop');assert.deepEqual(f.calls.map(call=>call.method),['GET']);
});
test('only structured immutable-field validation establishes replacement; invalid config and permissions remain blocked',async()=>{
  const f=fixture();f.change.desired={...f.resource,spec:{...f.resource.spec,spec:{...f.resource.spec.spec as JsonObject,selector:{matchLabels:{app:'new-app'}}}}};
  f.controls.validation={status:422,body:{kind:'Status',status:'Failure',code:422,reason:'Invalid',message:'PRIVATE-TOKEN /private/path',details:{name:'app',kind:'Deployment',causes:[{reason:'FieldValueInvalid',field:'spec.selector',message:'field is immutable'}]}}};
  const replacement=await f.decision();assert.equal(replacement.disposition,'replace');assert.deepEqual(replacement.changedPaths,['/spec/selector']);assert.equal(JSON.stringify(replacement).includes('PRIVATE'),false);
  f.controls.validation={status:422,body:{kind:'Status',status:'Failure',code:422,reason:'Invalid',details:{name:'app',kind:'Deployment',causes:[{reason:'FieldValueInvalid',field:'spec.replicas',message:'must be nonnegative'}]}}};
  assert.equal((await f.decision()).disposition,'blocked');
  f.controls.validation={status:403,body:{kind:'Status',reason:'Forbidden',message:'field is immutable'}};assert.equal((await f.decision()).disposition,'blocked');
});
test('version changes, conflicts and ambiguous response identities cannot promise an in-place update',async()=>{
  for(const mode of ['changed','conflict','wrong-object']){const f=fixture();
    if(mode==='changed')f.controls.changeAfterValidation=true;if(mode==='conflict')f.controls.validation={status:409,body:{kind:'Status',reason:'Conflict'}};
    if(mode==='wrong-object')f.controls.validation={status:200,body:{...f.resource.spec,metadata:{name:'other',namespace:'owned-review'}}};
    assert.equal((await f.decision()).disposition,'unknown');
  }
});
test('unowned resources, namespace substitution and existing replacement destinations are refused before dry-run',async()=>{
  const f=fixture();(f.live.metadata as {annotations:Record<string,string>}).annotations={};assert.equal((await f.decision()).disposition,'blocked');assert.deepEqual(f.calls.map(call=>call.method),['GET']);
  const scope=fixture();scope.change.desired={...scope.resource,spec:{...scope.resource.spec,metadata:{name:'app',namespace:'foreign'}}};await assert.rejects(()=>scope.decision(),/namespace/);assert.ok(scope.calls.every(call=>call.method==='GET'));
});
test('failed creation validation is not mistaken for a proven create when the object is absent',async()=>{
  const f=fixture();delete f.change.previous;f.controls.notFound=true;f.controls.validation={status:422,body:{kind:'Status',reason:'Invalid'}};
  assert.equal((await f.decision()).disposition,'blocked');
});
test('alternative validation strategy stays explicit and advertises matching executor and ownership requirements',async()=>{
  const f=fixture(mergePatchValidation()),decision=await f.decision();assert.equal(decision.disposition,'update');
  assert.equal(f.calls[1]!.contentType,'application/merge-patch+json');assert.ok(decision.requirements.includes('matching-update-executor'));assert.ok(decision.requirements.includes('field-ownership-review'));
  const ssa=fixture();ssa.controls.validation={status:409,body:{kind:'Status',reason:'Conflict'}};assert.equal((await ssa.decision()).disposition,'unknown');
  assert.equal(ssa.calls.filter(call=>call.method==='PATCH').length,1,'a conflict never automatically changes validation strategies');
});
test('a custom validation strategy cannot remove dry-run or change admitted manifest/preconditions',async()=>{
  for(const mode of ['persist','mutate-body']){
    const f=fixture({id:'custom',request(input){if(mode==='mutate-body')(input.body.metadata as JsonObject).resourceVersion='999';return{
      path:input.path+(mode==='persist'?'':'?dryRun=All'),body:input.body,contentType:'application/merge-patch+json',requirements:[]};}});
    await assert.rejects(()=>f.decision(),/preserve the admitted body and read-only target/);assert.deepEqual(f.calls.map(call=>call.method),['GET']);
  }
});
test('HTTPS transport refuses persisted requests, duplicate dry-run, redirects and insecure endpoints before network I/O',async()=>{
  assert.throws(()=>createHttpsKubernetesAssessmentTransport({server:'http://localhost:1234',ca:'test'}),/verified HTTPS/);
  const transport=createHttpsKubernetesAssessmentTransport({server:'https://localhost:1',ca:'test'});
  for(const path of ['/api/v1/namespaces/test','/api/v1/namespaces/test?dryRun=','/api/v1/namespaces/test?dryRun=All&dryRun=','https://elsewhere.invalid/api/v1/namespaces/test?dryRun=All',
    '/api/v1/namespaces/test/services/app/proxy?dryRun=All','/api/v1/namespaces/test/pods/app/proxy?dryRun=All','/apis/apps/v1/namespaces/test/deployments/app/status?dryRun=All',
    'https://localhost:1/api/v1/namespaces/test?dryRun=All','/api/v1/namespaces/test/services/app%2fproxy?dryRun=All'])await assert.rejects(()=>transport.request('PATCH',path,{}),/Only read-only/);
  await assert.rejects(()=>transport.request('GET','/api/v1/namespaces/test?watch=true'),/Only read-only/);
});
