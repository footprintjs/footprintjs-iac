import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { KubernetesAdapter } from '../src/providers/kubernetes.ts';
import { readNeoNativeMutationFailure } from '../integration/neo/native-mutation-failure.ts';
import { fingerprint } from '../src/util.ts';
import type { JsonObject, Stack } from '../src/types.ts';

for(const privateError of ['PRIVATE_API_INVALID_REPLICAS','PRIVATE_CONNECTION_RESET'])test(`Neo trial admits bounded mutation failure without classifying ${privateError}`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-neo-native-failure-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const stack:Stack={name:'native-failure',resources:[{id:'neo-app',provider:'kubernetes',spec:{apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'neo',namespace:'owned'},spec:{replicas:1}}}]};
  const live=structuredClone(stack.resources[0]!.spec);Object.assign(live.metadata as JsonObject,{uid:'original',resourceVersion:'1',generation:1,annotations:{
    'footprint-iac.dev/owner':fingerprint({stack:stack.name,id:'neo-app'}),'footprint-iac.dev/stack':stack.name,'footprint-iac.dev/resource':'neo-app',
  }});live.status={observedGeneration:1,updatedReplicas:1,availableReplicas:1,replicas:1};
  let writes=0;const adapter=new KubernetesAdapter({context:'controlled',namespace:'owned',runner:async(_file,args,options)=>{
    if(args.includes('get'))return{stdout:JSON.stringify(live)};if(args.includes('rollout'))return{stdout:'ready'};
    if(args.includes('apply')){writes++;assert.equal(JSON.parse(options.input!).spec.replicas,-1);throw Error(privateError);}throw Error('Unexpected command');
  }});
  const engine=new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),traceDirectory:join(directory,'trace')});
  assert.equal((await engine.apply(stack)).ok,true);const invalid=structuredClone(stack);(invalid.resources[0]!.spec.spec as JsonObject).replicas=-1;
  const result=await engine.apply(invalid);assert.equal(result.ok,false);assert.ok(writes>0);
  const measured=await readNeoNativeMutationFailure(result,invalid.resources[0]!);assert.equal(measured.status,'unconfirmed');assert.ok(measured.boundaries.length>0);
  assert.equal((live.spec as JsonObject).replicas,1);assert.equal((await readFile(result.evidencePath,'utf8')).includes(privateError),false);
  await assert.rejects(()=>readNeoNativeMutationFailure(result,stack.resources[0]!));
});
