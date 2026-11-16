import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { createSystemdHost } from '../src/deployment-strategy/host.ts';
import { SystemdResourceAdapter } from '../src/deployment-strategy/systemd-resource.ts';
import { compileSystemdDeployment } from '../src/deployment-strategy/compile.ts';
import { createAdapterFlowRecorder } from '../src/adapter-flow/recorder.ts';
import { admitAdapterFlowEvents } from '../src/adapter-flow/admission.ts';
import type { SystemdUnitObservation } from '../src/deployment-strategy/types.ts';

const hash='a'.repeat(64),units=['api','tools'].map(id=>({id,name:`${id}.service`,fragmentPath:`/etc/systemd/system/${id}.service`,configurationDigest:hash}));
function fixture(failStart=false){
  const operations:string[]=[],facts:SystemdUnitObservation[]=units.map(unit=>({name:unit.name,exists:true,fragmentPath:unit.fragmentPath,fragmentDigest:hash,configurationDigest:hash,activeState:'active',invocationId:'b'.repeat(32),appliedSpecDigest:null}));
  const host=createSystemdHost({units:units.map(unit=>({name:unit.name,workingDirectory:'/opt/app'})),sudo:false,runner:async command=>{
    const input=JSON.parse(command.input);operations.push(input.operation);
    if(input.operation==='inspect')return{code:0,stdout:JSON.stringify({identityDigest:hash,units:facts.map(unit=>({...unit,workingDirectory:'/opt/app'}))})};
    if(input.operation==='flow-start'){
      if(failStart)throw Error('PRIVATE_TRANSPORT');
      for(const unit of facts){unit.appliedSpecDigest=input.request.desiredSpecDigest;unit.invocationId='c'.repeat(32);}
    }
    if(input.operation==='flow-observe')return{code:0,stdout:JSON.stringify({identityDigest:hash,unit:facts.find(unit=>unit.name===input.selectedUnit)})};
    return {code:0,stdout:'{"ok":true}'};
  }});
  return{host,operations};
}
test('real systemd host boundaries remain one group effect, expose admitted component reads, and verify no-op without restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-systemd-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {host,operations}=fixture(),recorder=createAdapterFlowRecorder();
  const adapter=new SystemdResourceAdapter({hostId:'server',scope:'server',identityDigest:hash},units,host);
  assert.equal(operations.length,0,'construction and declaration never inspect a provider');
  const graph=compileSystemdDeployment({stack:'native-services',units,releaseDigest:hash});
  adapter.permit(await adapter.inspect());
  const engine=new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'state')),traceDirectory:join(directory,'trace'),recorders:[recorder]});
  const first=await engine.apply(graph);assert.equal(first.ok,true);
  assert.deepEqual(operations.filter(operation=>operation.startsWith('flow-')),['flow-revalidate','flow-configure','flow-reload','flow-start','flow-observe','flow-observe']);
  const events=recorder.getEvents();assert.equal(recorder.getSnapshot().ignoredEvents,0);
  assert.ok(events.some(event=>event.phase==='start'&&event.status==='passed'));
  assert.ok(events.every(event=>!('components'in event)),'structural superset binding is projected to public fields');
  const evidence=JSON.parse(await readFile(first.evidencePath,'utf8'));
  const components=units.map(unit=>({componentId:unit.id,resourceId:'systemd-services'}));
  const admitted=await admitAdapterFlowEvents({evidence,plan:first.plan,events,components});
  assert.deepEqual(admitted.map(row=>[row.componentId,row.phase,row.running]),[['api','observe',true],['tools','observe',true]]);
  const before=operations.length,second=await engine.apply(graph);assert.equal(second.ok,true);
  assert.ok(operations.slice(before).every(operation=>operation==='inspect'),'no-op performs measured reads only');
  assert.deepEqual([...new Set(recorder.getEvents().filter(event=>event.componentId&&event.phase==='observe').map(event=>event.componentId))],['api','tools']);
  const nextEvidence=JSON.parse(await readFile(second.evidencePath,'utf8'));
  assert.equal((await admitAdapterFlowEvents({evidence:nextEvidence,plan:second.plan,events:recorder.getEvents(),components})).length,2);
});

test('unconfirmed native systemd restart skips per-unit success and remains blocked across reopening',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-systemd-native-failure-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {host,operations}=fixture(true),recorder=createAdapterFlowRecorder(),store=new FileStateStore(join(directory,'state'));
  const adapter=new SystemdResourceAdapter({hostId:'server',scope:'server',identityDigest:hash},units,host);adapter.permit(await adapter.inspect());
  const engine=new InfraEngine({adapters:[adapter],store,traceDirectory:join(directory,'trace'),recorders:[recorder]});
  const graph=compileSystemdDeployment({stack:'failed-services',units,releaseDigest:hash}),result=await engine.apply(graph);
  assert.equal(result.ok,false);assert.equal(operations.filter(operation=>operation==='flow-start').length,1);
  assert.ok(operations.every(operation=>operation!=='flow-observe'));
  assert.ok(recorder.getEvents().every(event=>event.phase!=='observe'||event.componentId===undefined));
  assert.ok((await store.load(graph.name)).resources['systemd-services']?.pending);
  assert.equal((await readFile(result.evidencePath,'utf8')).includes('PRIVATE_TRANSPORT'),false);
  const reopened=new InfraEngine({adapters:[adapter],store});await assert.rejects(()=>reopened.apply(graph),/unsafe pending effect/);
});
