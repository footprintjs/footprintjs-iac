import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DeliveryWorkflow,FileDeliveryStore,loadDeliveryRecording,DeploymentPreflightRefused,readWorkflowEvidenceReferences,combineWorkflowEvidenceReferences} from '../src/delivery/node.ts';
import {readDeliveryPlan,readDeliveryDeployment} from '../src/delivery/data.ts';
import {readRolloutReceipt} from '../src/pipeline/data.ts';

const reference={kind:'change-assessment-plan',digest:'a'.repeat(64),runId:'native-preflight-17'};
test('public evidence reference admission rejects host paths, endpoints, extra fields, accessors, duplicate identities and unbounded arrays',()=>{
  assert.deepEqual(readWorkflowEvidenceReferences([reference]),[reference]);
  assert.deepEqual(combineWorkflowEvidenceReferences([reference],[{...reference}]),[reference]);
  for(const input of [
    [{...reference,path:'/private/credentials'}],
    [{...reference,runId:'https://service.example/token'}],
    [{...reference,kind:'file:///private'}],
    [{...reference,digest:'not-a-content-digest'}],
    [reference,{runId:reference.runId,kind:reference.kind,digest:reference.digest}],
    Array.from({length:17},(_,index)=>({...reference,runId:'run-'+index})),
  ]){
    assert.throws(()=>readWorkflowEvidenceReferences(input));
    assert.throws(()=>readDeliveryPlan({id:'plan',digest:'b'.repeat(64),changes:[],evidence:input}));
    assert.throws(()=>readDeliveryDeployment({ok:true,evidence:input}));
    assert.throws(()=>readRolloutReceipt({status:'succeeded',evidence:input}));
  }
  let invoked=0;const accessor={...reference};Object.defineProperty(accessor,'runId',{enumerable:true,get(){invoked++;return 'secret';}});
  assert.throws(()=>readWorkflowEvidenceReferences([accessor]));assert.equal(invoked,0);
});

test('a confirmed before-effects preflight refusal retains its independent native evidence link and never invokes deployment',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'delivery-preflight-evidence-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let effects=0;
  const source={repository:'https://github.com/example/neo',ref:'v2',commit:'1'.repeat(40),tree:'2'.repeat(40)};
  const artifacts=[{id:'app',digest:'3'.repeat(64),reference:'registry.example/app:v2'}];
  const workflow=new DeliveryWorkflow({definition:{id:'safe-before-effects',label:'Assessed deployment',target:{id:'dev',scope:'owned-dev'},
    source:{repository:source.repository,ref:source.ref},recipe:{id:'build',digest:'4'.repeat(64)},configurationDigest:'5'.repeat(64)},
    store:new FileDeliveryStore(directory),adapters:{
      source:{async resolve(){return source;},async fetch(){return{revision:source,location:'/private/pinned-source'};}},
      build:{async build(){return{artifacts,recipeDigest:'4'.repeat(64)};}},artifacts:{async publish(){return{artifacts};}},
      deployment:{async plan(){throw new DeploymentPreflightRefused([reference]);},async deploy(){effects++;throw Error('must not execute');},async verify(){throw Error('must not verify');}}
    }});
  const state=await workflow.start();assert.equal(state.status,'failed');assert.equal(effects,0);
  const native=await loadDeliveryRecording(state.recordings[0]!.evidencePath),shared=(native.snapshot as {sharedState:Record<string,unknown>}).sharedState;
  assert.deepEqual(shared.failure,{stageId:'plan',code:'delivery-stage-failed',evidence:[reference]});
  assert.equal(JSON.stringify(native).includes('/private/pinned-source'),false,'private host source locations never enter the native link');
});
