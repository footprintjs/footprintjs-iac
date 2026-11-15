import assert from 'node:assert/strict';
import test from 'node:test';
import {KubernetesChangeAssessmentAdapter,ownedBootstrapServerSideApplyValidation,serverSideApplyValidation,type KubernetesAssessmentTransport,type KubernetesUpdateValidationStrategy} from '../src/change-assessment/kubernetes.ts';
import {canMigrateKubernetesBootstrap} from '../src/providers/kubernetes-bootstrap.ts';
import {fingerprint} from '../src/util.ts';
import type {JsonObject,Resource} from '../src/types.ts';

const stack='neo-bootstrap',scope='fixture-target',namespace='neo-test';
const previous:Resource={id:'neo-app',provider:'kubernetes',spec:{apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'neo',namespace},
  spec:{replicas:1,selector:{matchLabels:{app:'neo'}},template:{metadata:{labels:{app:'neo'}},spec:{containers:[{name:'node',image:'sha256:'+'1'.repeat(64)}]}}}}};
const desired=structuredClone(previous);((((desired.spec.spec as JsonObject).template as JsonObject).spec as JsonObject).containers as JsonObject[])[0]!.image='sha256:'+'2'.repeat(64);
const own={manager:'footprint-iac',operation:'Update',apiVersion:'apps/v1',fieldsType:'FieldsV1',fieldsV1:{'f:spec':{'.':{}}}};
function object(managed:unknown[]=[own]){return{...structuredClone(previous.spec),metadata:{...(previous.spec.metadata as JsonObject),uid:'original-uid',resourceVersion:'17',generation:1,
  annotations:{'footprint-iac.dev/owner':fingerprint({stack,id:previous.id}),'footprint-iac.dev/stack':stack,'footprint-iac.dev/resource':previous.id},managedFields:managed},
  status:{observedGeneration:1,updatedReplicas:1,availableReplicas:1,replicas:1}} as JsonObject;}
const change={id:'neo-image',label:'Neo image',adapterId:'kube',strategyId:'conservative',data:'unknown' as const,previous,desired};
const context={executionId:'test',operationId:'probe',definitionDigest:'a'.repeat(64),target:{id:'target',scope}};
function probe(live:JsonObject,strategy:KubernetesUpdateValidationStrategy=ownedBootstrapServerSideApplyValidation(),status=200){
  const calls:{method:string;path:string;body?:unknown}[]=[];
  const transport:KubernetesAssessmentTransport={async request(method,path,body){calls.push({method,path,body});return method==='GET'?{status:200,body:structuredClone(live)}:{status,body:status===200?body:{kind:'Status',reason:'Conflict'}};}};
  return{calls,adapter:new KubernetesChangeAssessmentAdapter({id:'kube',scope,stack,namespace,transport,validationStrategy:strategy})};
}

test('Neo preflight explicitly dry-runs the same bounded own-bootstrap SSA transition as the executor',async()=>{
  const live=object(),f=probe(live),result=await f.adapter.probe(change,context);
  assert.equal(result.update,'supported');assert.deepEqual(result.requirements,['matching-owned-bootstrap-executor']);
  const patch=f.calls.find(call=>call.method==='PATCH')!,url=new URL(patch.path,'https://fixture.invalid');
  assert.equal(url.searchParams.get('force'),'true');assert.equal(url.searchParams.get('dryRun'),'All');
  const body=patch.body as JsonObject;assert.equal((body.metadata as JsonObject).uid,'original-uid');assert.equal((body.metadata as JsonObject).resourceVersion,'17');
  assert.equal(canMigrateKubernetesBootstrap(live,body),true);
  assert.deepEqual(f.calls.map(call=>call.method),['GET','PATCH','GET'],'one selected dry-run and a fresh version check');
});

test('foreign main-resource or overlapping status ownership cannot enable the bootstrap force mode',async()=>{
  const unsafe=[
    [own,{...own,manager:'someone-else'}],
    [own,{...own,manager:'controller',subresource:'status',fieldsV1:{'f:spec':{}}}],
    [own,{...own,manager:'controller',subresource:'status',fieldsV1:{'k:unknown':{}}}],
    [{...own,operation:'Apply'}],
    [],
  ];
  for(const fields of unsafe){
    const live=object(fields),f=probe(live,ownedBootstrapServerSideApplyValidation(),409),result=await f.adapter.probe(change,context);
    assert.equal(result.update,'unknown');assert.equal(canMigrateKubernetesBootstrap(live,desired.spec),false);
    assert.equal(new URL(f.calls.find(call=>call.method==='PATCH')!.path,'https://fixture.invalid').searchParams.has('force'),false);
    assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1,'a conflict never selects another validation mechanism');
  }
  const nonoverlap=object([own,{...own,manager:'controller',subresource:'status',fieldsV1:{'f:status':{}}}]);
  assert.equal(canMigrateKubernetesBootstrap(nonoverlap,desired.spec),true);
});

test('the default SSA probe stays non-force and a custom strategy cannot bypass bootstrap evidence',async()=>{
  const normal=probe(object(),serverSideApplyValidation());await normal.adapter.probe(change,context);
  assert.equal(new URL(normal.calls.find(call=>call.method==='PATCH')!.path,'https://fixture.invalid').searchParams.has('force'),false);
  const custom:KubernetesUpdateValidationStrategy={id:'custom',request(input){return{path:input.path+'?dryRun=All&fieldManager=footprint-iac&force=true',body:input.body,
    contentType:'application/apply-patch+yaml',requirements:['matching-owned-bootstrap-executor']};}};
  const unsafe=probe(object([own,{...own,manager:'foreign'}]),custom);
  await assert.rejects(()=>unsafe.adapter.probe(change,context),/preserve.*read-only/);
  assert.equal(unsafe.calls.some(call=>call.method==='PATCH'),false,'no request may force a foreign field manager');
});
