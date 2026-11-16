import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { KubernetesAdapter } from '../src/providers/kubernetes.ts';
import { createAdapterFlowRecorder } from '../src/adapter-flow/recorder.ts';
import { admitAdapterFlowEvents } from '../src/adapter-flow/admission.ts';
import type { JsonObject, Stack } from '../src/types.ts';

test('native Kubernetes retains safe retries, exact mutation preconditions and real no-op component observations',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-kube-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let live:JsonObject|undefined,creates=0;const calls:string[][]=[],recorder=createAdapterFlowRecorder();
  const adapter=new KubernetesAdapter({context:'controlled',namespace:'app',runner:async(_file,args,options)=>{
    calls.push([...args]);
    if(args.includes('get'))return{stdout:live?JSON.stringify(live):''};
    if(args.includes('create')){
      creates++;if(creates===1)throw Error('PRIVATE_TRANSPORT');
      live=JSON.parse(options.input!);Object.assign(live!.metadata as JsonObject,{uid:'object-one',resourceVersion:'1'});return{stdout:JSON.stringify(live)};
    }
    if(args.includes('apply')){
      const body=JSON.parse(options.input!);assert.equal(body.metadata.uid,'object-one');assert.equal(body.metadata.resourceVersion,'1');
      assert.ok(!args.includes('--force-conflicts=true'));live=body;return{stdout:JSON.stringify(live)};
    }
    throw Error('Unexpected command');
  }});
  const stack:Stack={name:'native-kubernetes',resources:[{id:'settings',provider:'kubernetes',spec:{apiVersion:'v1',kind:'ConfigMap',metadata:{name:'settings',namespace:'app'},data:{mode:'one'}}}]};
  const engine=new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),traceDirectory:join(directory,'trace'),recorders:[recorder]});
  assert.equal(adapter.supportsSafeRetry,true);const result=await engine.apply(stack);assert.equal(result.ok,true);assert.equal(creates,2);assert.equal((result.results.settings as {attempts:number}).attempts,2);
  assert.ok(recorder.getEvents().some(event=>event.phase==='apply'&&event.status==='unknown'));
  const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));assert.equal(JSON.stringify(evidence).includes('PRIVATE_TRANSPORT'),false);
  const components=[{componentId:'settings',resourceId:'settings'}];assert.equal((await admitAdapterFlowEvents({evidence,plan:result.plan,events:recorder.getEvents(),components}))[0]?.running,true);
  const before=calls.length,noOp=await engine.apply(stack);assert.equal(noOp.ok,true);assert.ok(calls.slice(before).every(args=>args.includes('get')));
  assert.ok(recorder.getEvents().some(event=>event.componentId==='settings'&&event.phase==='observe'&&event.running===true));
  const changed=structuredClone(stack);((changed.resources[0]!.spec.data) as JsonObject).mode='two';
  assert.equal((await engine.apply(changed)).ok,true);assert.equal(calls.filter(args=>args.includes('apply')).length,1);
});
