import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fingerprint} from '../src/util.ts';
import {ChangeAssessmentWorkflow,FileChangeAssessmentStore,DeclaredContractAssessmentAdapter,conservativeChangeStrategy,
  loadChangeAssessmentRecording,readChangeAssessmentReport,sealChangeAssessmentReport} from '../src/change-assessment/node.ts';
import {readChangeAssessmentReportShape} from '../src/change-assessment/index.ts';
import type {ChangeAssessmentDefinition,ChangeAssessmentRegistry,ChangeProbe,ResourceChange} from '../src/change-assessment/types.ts';
import {admitChangeDisposition} from '../src/change-assessment/strategy.ts';
import {inspectRecordedDependencies} from '../src/diagnostics/recorded-slice.ts';

async function fixture(t:{after(fn:()=>Promise<void>):void},alter?:'unknown'|'unowned'|'throw'){
  const directory=await mkdtemp(join(tmpdir(),'iac-assess-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const previous={id:'database',provider:'test-provider',spec:{schemaVersion:1,replicas:1,password:'PRIVATE-ROW-PASSWORD',handle:'/private/database.sqlite'}};
  const changes:ResourceChange[]=[
    {id:'database',label:'Conversation store',adapterId:'contract',strategyId:'conservative',data:'stateful',previous,desired:{...previous,spec:{...previous.spec,schemaVersion:2}}},
    {id:'compute',label:'Application',adapterId:'contract',strategyId:'custom',data:'stateless',previous:{...previous,id:'app'},desired:{...previous,id:'app',spec:{...previous.spec,replicas:2}}},
    {id:'unchanged',label:'Network',adapterId:'second',strategyId:'conservative',data:'stateless',previous:{...previous,id:'network'},desired:{...previous,id:'network'}},
  ];
  const definition:ChangeAssessmentDefinition={version:1,id:'change-v2',label:'Review changes',target:{id:'local',scope:'private-scope'},configurationDigest:'a'.repeat(64),changes};
  const calls:string[]=[],store=new FileChangeAssessmentStore(directory),controls:{gate?:Promise<void>}={};
  const adapter=new DeclaredContractAssessmentAdapter({id:'contract',provider:'test-provider',scope:definition.target.scope,mutablePaths:['/spec/replicas'],replacementPaths:['/spec/schemaVersion'],
    async observe(change){calls.push(change.id);assert.equal((await store.load())!.events.at(-1)!.status,'checking');
      if(controls.gate)await controls.gate;if(alter==='throw')throw Error('PRIVATE-PROVIDER-EXCEPTION');
      return{exists:true,owned:alter!=='unowned',physicalId:'/private/source-object',revision:'provider-version-1',fingerprint:alter==='unknown'?'9'.repeat(64):fingerprint(change.previous!.spec),ready:true};
    }});
  const strategy=conservativeChangeStrategy();
  const registry:ChangeAssessmentRegistry={adapters:[adapter,{id:'second',provider:'test-provider',scope:definition.target.scope,async probe(change){calls.push(change.id);return{observation:{exists:true,owned:true,physicalId:'private-object-2',fingerprint:fingerprint(change.desired!.spec),ready:true},update:'not-needed',reasons:[],validation:'declared-contract'};}}],
    strategies:[strategy,{id:'custom',label:'Custom provider policy',classify:strategy.classify}]};
  return{directory,definition,calls,store,registry,controls,workflow:()=>new ChangeAssessmentWorkflow({definition,store,registry})};
}
test('provider/strategy registry classifies replacement, in-place update and unchanged resources in one native read-only assessment',async t=>{
  const f=await fixture(t),workflow=f.workflow(),state=await workflow.start();assert.equal(state.status,'complete');
  assert.deepEqual(state.decisions.map(item=>item.disposition),['replace','update','noop']);assert.deepEqual(f.calls,['database','compute','unchanged']);
  assert.ok(state.report!.changes[0]!.requirements.includes('verified-backup'));assert.ok(state.report!.changes[0]!.requirements.includes('retain-original'));
  assert.deepEqual(state.report!.changes[0]!.changedPaths,['/spec/schemaVersion']);assert.equal(state.events.length,6);
  assert.deepEqual(readChangeAssessmentReport(state.report),state.report);assert.deepEqual(readChangeAssessmentReportShape(state.report),state.report);
  const receipt=state.recording!,recorded=await loadChangeAssessmentRecording(receipt.evidencePath,{runId:receipt.runId,executionId:state.executionId!,definitionDigest:state.definitionDigest});
  assert.equal(recorded.complete,true);assert.equal((recorded.snapshot as {commitLog:unknown[]}).commitLog.length,17);
  for(const path of [receipt.evidencePath,receipt.tracePath]){const bytes=await readFile(path,'utf8');for(const value of ['PRIVATE-ROW-PASSWORD','/private/database.sqlite','/private/source-object','private-scope'])assert.equal(bytes.includes(value),false);}
  assert.deepEqual(await f.workflow().start(),state);assert.equal(f.calls.length,3,'record replay performs no provider probes');
});
test('decision backwalk follows separate sanitized observation, capability, policy and common admission writers',async t=>{
  const f=await fixture(t),state=await f.workflow().start(),native=JSON.parse(await readFile(state.recording!.evidencePath,'utf8'));
  const shared=native.snapshot.sharedState;
  assert.equal(shared['observation:database'].source.identityDigest,fingerprint('/private/source-object'));
  assert.equal(shared['observation:database'].source.revisionDigest,fingerprint('provider-version-1'));
  assert.equal(shared['observation:database'].source.owned,true);
  assert.equal(shared['capability:database'].update,'replacement-required');
  assert.equal(shared['capability:database'].validation,'declared-contract');
  assert.deepEqual(shared['capability:database'].changedPaths,['/spec/schemaVersion']);
  assert.equal(shared['classification:database'].disposition,'replace');
  assert.equal(shared['admission:database'].disposition,'replace');
  const result=inspectRecordedDependencies(native,'decision:database').result;
  assert.equal(result.status,'available');assert.equal(result.provenance.recorded,'reads-prefix');
  const nodes=Object.keys(result.dependencies!.nodes!),edges=result.dependencies!.edges!;
  for(const stage of ['observe-0','capability-0','classify-0','admit-0','decision-0'])assert.ok(nodes.some(id=>id.includes(stage)),stage+' must appear as an actual native writer');
  for(const [from,to,key] of [['decision-0','admit-0','admission:database'],['admit-0','classify-0','classification:database'],
    ['classify-0','capability-0','capability:database'],['capability-0','observe-0','observation:database']]){
    assert.ok(edges.some(edge=>edge.from.includes(from!)&&edge.to.includes(to!)&&edge.key===key),'Missing recorded fact dependency '+key);
  }
  assert.equal(nodes.some(id=>id.includes('observe-1')),false,'Another resource observation is not invented as a cause');
  for(const path of [state.recording!.evidencePath,state.recording!.tracePath])for(const value of ['PRIVATE-ROW-PASSWORD','/private/database.sqlite','/private/source-object','provider-version-1'])assert.equal((await readFile(path,'utf8')).includes(value),false);
  assert.deepEqual(await f.workflow().snapshot(),state);assert.equal(f.calls.length,3);
});
test('a rejected custom policy remains backwalkable to unavailable capability and the common admission guard',async t=>{
  const f=await fixture(t);f.definition.changes=[f.definition.changes[0]!];
  f.registry.adapters=[{id:'contract',provider:'test-provider',scope:f.definition.target.scope,async probe(){return{
    observation:{exists:true,owned:true,fingerprint:'9'.repeat(64)},update:'unknown',reasons:['provider-validation-unavailable'],validation:'not-checked'};}}];
  f.registry.strategies=[{id:'conservative',label:'Untrusted optimistic choice',classify:()=>({disposition:'update',reasons:['policy-requested-update']})}];
  const state=await f.workflow().start(),native=JSON.parse(await readFile(state.recording!.evidencePath,'utf8'));
  assert.equal(state.decisions[0]!.disposition,'unknown');
  assert.equal(native.snapshot.sharedState['classification:database'].disposition,'update');
  assert.deepEqual(native.snapshot.sharedState['admission:database'],{disposition:'unknown',reasons:['update-not-established']});
  const explanation=inspectRecordedDependencies(native,'decision:database').result;
  assert.ok(explanation.dependencies!.edges!.some(edge=>edge.key==='capability:database'));
  assert.ok(explanation.dependencies!.edges!.some(edge=>edge.key==='admission:database'));
});
test('missing permissions, drift and provider exceptions stay blocked or unknown, never an absence/create',async t=>{
  for(const mode of ['unknown','unowned','throw'] as const){const f=await fixture(t,mode),state=await f.workflow().start();assert.equal(state.status,'complete');
    assert.equal(state.decisions[0]!.disposition,mode==='unowned'?'blocked':'unknown');
    const native=JSON.parse(await readFile(state.recording!.evidencePath,'utf8'));
    assert.equal(native.snapshot.sharedState['observation:database'].available,mode!=='throw');
    for(const path of [state.recording!.evidencePath,state.recording!.tracePath])assert.equal((await readFile(path,'utf8')).includes('PRIVATE-PROVIDER-EXCEPTION'),false);
  }
});
test('custom strategy keeps its private input contract without publishing handles or exception details',async t=>{
  const f=await fixture(t);f.definition.changes=[f.definition.changes[1]!];let calls=0;
  f.registry.strategies=[{id:'custom',label:'Host-registered policy',classify(change,probe){
    calls++;assert.equal(probe.observation.physicalId,'/private/source-object');assert.equal(change.previous!.spec.password,'PRIVATE-ROW-PASSWORD');
    return{disposition:'update',reasons:['host-policy-accepted']};
  }}];
  const passed=await f.workflow().start();assert.equal(passed.status,'complete');assert.equal(passed.decisions[0]!.disposition,'update');assert.equal(calls,1);
  for(const path of [passed.recording!.evidencePath,passed.recording!.tracePath])for(const secret of ['/private/source-object','PRIVATE-ROW-PASSWORD'])assert.equal((await readFile(path,'utf8')).includes(secret),false);
  const rejected=await fixture(t);rejected.definition.changes=[rejected.definition.changes[1]!];
  rejected.registry.strategies=[{id:'custom',label:'Failing private policy',classify(){throw Error('PRIVATE-POLICY-EXCEPTION');}}];
  const failed=await rejected.workflow().start();assert.equal(failed.status,'incomplete');assert.equal(failed.report,undefined);
  for(const path of [failed.recording!.evidencePath,failed.recording!.tracePath])assert.equal((await readFile(path,'utf8')).includes('PRIVATE-POLICY-EXCEPTION'),false);
});
test('unregistered scope/strategy fails before reads and custom policy cannot manufacture provider update capability',async t=>{
  const f=await fixture(t);assert.throws(()=>new ChangeAssessmentWorkflow({definition:{...f.definition,target:{id:'different',scope:'different'}},store:f.store,registry:f.registry}),/exact target/);assert.equal(f.calls.length,0);
  const adapter={id:'contract',provider:'test-provider',scope:f.definition.target.scope,async probe():Promise<ChangeProbe>{return{observation:{exists:true,owned:true,fingerprint:'9'.repeat(64)},update:'unknown',reasons:['unsupported-change'],validation:'not-checked'};}};
  const registry={adapters:[adapter,...f.registry.adapters.filter(value=>value.id!=='contract')],strategies:[{id:'conservative',label:'Unsafe custom policy',classify:()=>({disposition:'update' as const,reasons:[]})},...f.registry.strategies.filter(value=>value.id!=='conservative')]};
  const state=await new ChangeAssessmentWorkflow({definition:f.definition,store:f.store,registry}).start();assert.equal(state.decisions[0]!.disposition,'unknown');assert.ok(state.decisions[0]!.reasons.includes('update-not-established'));
});
test('retention and replacement destination ownership remain required; a report cannot invoke deletion',async t=>{
  const f=await fixture(t);f.definition.changes=[{...f.definition.changes[0]!,desired:undefined,previous:{...f.definition.changes[0]!.previous!,lifecycle:{retainOnRemoval:true}}}];delete f.definition.changes[0]!.desired;
  const state=await f.workflow().start();assert.equal(state.decisions[0]!.disposition,'blocked');assert.ok(state.decisions[0]!.reasons.includes('retention-required'));
  const other=await fixture(t);other.registry.adapters=[{id:'contract',provider:'test-provider',scope:other.definition.target.scope,async probe(){return{observation:{exists:true,owned:true,physicalId:'old',fingerprint:fingerprint(other.definition.changes[0]!.previous!.spec)},destination:{exists:true,owned:true,physicalId:'another'},update:'replacement-required',reasons:[],validation:'declared-contract'};}},other.registry.adapters[1]!];
  assert.equal((await other.workflow().start()).decisions[0]!.disposition,'blocked');
});
test('digest, native replay and immutable source bindings reject forged assessment reports',async t=>{
  const f=await fixture(t),state=await f.workflow().start(),tampered=structuredClone(state.report!);tampered.changes[0]!.disposition='update';assert.throws(()=>readChangeAssessmentReport(tampered),/digest changed/);
  const modified=structuredClone(state);modified.decisions[0]!.disposition='update';const{digest:_,...body}=modified.report!;modified.report=sealChangeAssessmentReport({...body,changes:modified.decisions});await writeFile(f.store.path,JSON.stringify(modified));
  await assert.rejects(()=>f.workflow().snapshot(),/differs from native/);
  await writeFile(f.store.path,JSON.stringify(state));await writeFile(state.recording!.tracePath,'{"unexpected":"entry"}\n',{flag:'a'});await assert.rejects(()=>f.workflow().snapshot(),/incomplete or changed/);
});
test('overlapping assessment attempts serialize, and incomplete attempts cannot silently repeat probes',async t=>{
  const f=await fixture(t);let release!:()=>void;f.controls.gate=new Promise<void>(resolve=>{release=resolve;});const first=f.workflow().start();
  while(!f.calls.length)await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(()=>f.workflow().start(),/locked/);release();assert.equal((await first).status,'complete');
  const running=structuredClone(await f.store.load());running!.status='running';delete running!.report;delete running!.recording;await writeFile(f.store.path,JSON.stringify(running));
  const count=f.calls.length;await assert.rejects(()=>f.workflow().start(),/already started/);assert.equal(f.calls.length,count);
});
test('custom strategies cannot bypass failed creation validation, missing stateful data or logical ownership identity',()=>{
  const change:ResourceChange={id:'store',label:'Store',adapterId:'provider',strategyId:'custom',data:'stateful',previous:{id:'old',provider:'provider',spec:{schema:1}},desired:{id:'new',provider:'provider',spec:{schema:1}}};
  const probe:ChangeProbe={observation:{exists:false},update:'rejected',reasons:[],validation:'provider-dry-run'};
  assert.equal(admitChangeDisposition(change,probe,'create').disposition,'blocked');
  assert.equal(admitChangeDisposition(change,{...probe,update:'supported'},'create').disposition,'unknown');
  assert.equal(admitChangeDisposition({...change,data:'stateless',previous:undefined},{...probe,update:'unknown'},'create').disposition,'unknown');
  const observed={...probe,observation:{exists:true,owned:true,fingerprint:fingerprint(change.desired!.spec)},update:'not-needed' as const};
  assert.equal(admitChangeDisposition(change,observed,'noop').disposition,'blocked');assert.equal(admitChangeDisposition(change,observed,'verify').disposition,'blocked');
});
