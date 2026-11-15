import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord,stateAt } from 'foottrace';
import { fingerprint,canonical } from '../src/util.ts';
import { MigrationWorkflow,FileMigrationStore,FileMigrationLocks,offlineTransferStrategy,loadMigrationRecording,type MigrationDefinition,type MigrationAdapter,type MigrationObservation,type MigrationReceipt,type MigrationRequest,type MigrationPhase,type MigrationRegistry } from '../src/migration/node.ts';
const hash=(value:unknown)=>fingerprint(value);
async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const directory=await mkdtemp(join(tmpdir(),'iac-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const definition:MigrationDefinition={version:1,id:'replace-data',label:'Replace retained state',assessmentDigest:'a'.repeat(64),changeId:'database-replacement',configurationDigest:'b'.repeat(64),source:{id:'original',scope:'/private/source',identity:hash('source-id')},destination:{id:'replacement',scope:'/private/destination'},strategyId:'offline-transfer',adapterId:'tool-a'};
 let source=[{id:'user-1',value:'retained-secret-row'}],destination:typeof source|undefined,backup:typeof source|undefined,fence:MigrationObservation['fence']=null,active:MigrationObservation['active']='source';
 let destinationIdentity=hash('replacement-id'),backupDigest='',writesAfter:MigrationObservation['writesAfterCutover']='none',compatible=true;
 const calls:string[]=[],controls:{fail?:string;unknown?:string;substitute?:string;writeAfterResume?:boolean;gate?:Promise<void>;entered?:()=>void}={};
 let store:FileMigrationStore;const stores:FileMigrationStore[]=[];
 const observation=():MigrationObservation=>({source:{...definition.source,snapshot:hash(source)},...(destination?{destination:{...definition.destination,identity:destinationIdentity,snapshot:hash(destination)}}:{}),...(backup?{backup:{id:'backup-1',digest:backupDigest,sourceSnapshot:hash(backup)}}:{}),fence,active,writesAfterCutover:writesAfter,sourceRetained:true,rollbackCompatible:compatible});
 const adapter:MigrationAdapter={id:'tool-a',label:'First provider',capabilities:['inspect','quiesce','backup','create','transfer','verify-data','cutover','verify-consumer','retain','resume','recover-source','verify-recovery','resume-source'],
  async observe(){return observation();},async execute(step,request){
   const saved=(await Promise.all(stores.map(store=>store.load()))).find(state=>state?.executionId===request.executionId);assert.equal(saved!.operations.at(-1)!.status,'intent');assert.equal(saved!.operations.at(-1)!.request.operationId,request.operationId);calls.push(step.phase);controls.entered?.();if(controls.gate)await controls.gate;
   switch(step.phase){
    case'inspect':break;
    case'quiesce':fence={id:hash('fence-'+request.executionId),owner:request.executionId};break;
    case'backup':backup=structuredClone(source);backupDigest=hash(backup);break;
    case'create':destination=[];break;
    case'transfer':destination=structuredClone(backup!);break;
    case'cutover':active='destination';break;
    case'recover-source':active='source';break;
    case'resume':case'resume-source':fence=null;if(controls.writeAfterResume){if(active==='destination'){destination!.push({id:'new-write',value:'after-unfence'});writesAfter='present';}else source.push({id:'new-write',value:'after-unfence'});}break;
   }
   if(controls.unknown===step.phase)throw Error('SECRET-ADAPTER-EXCEPTION');
   const receipt:MigrationReceipt={request,status:controls.fail===step.phase?'failed':'succeeded',observation:observation(),metadata:{path:'/private/dump.sqlite',row:source[0]!.value,secret:'SECRET-ADAPTER-EXCEPTION'}};
   if(step.phase==='backup')receipt.backup=observation().backup;
   if(step.phase==='verify-data')receipt.verification={id:'data-proof',digest:hash({source,destination}),passed:canonical(source)===canonical(destination),sourceSnapshot:hash(source),destinationSnapshot:hash(destination)};
   if(step.phase==='verify-consumer'||step.phase==='verify-recovery')receipt.consumer={id:'consumer-proof',digest:hash(active),passed:true,activeIdentity:active==='source'?definition.source.identity:destinationIdentity};
   if(controls.substitute===step.phase)receipt.request={...request,source:{...request.source,identity:'f'.repeat(64)}};
   return receipt;
  }};
 const registry:MigrationRegistry={strategies:[offlineTransferStrategy()],adapters:[adapter]},locks=new FileMigrationLocks(join(directory,'shared-locks'));
 function workflow(name='attempt',definitionInput=definition,registryInput=registry){store=new FileMigrationStore(join(directory,name));stores.push(store);return {store,workflow:new MigrationWorkflow({definition:definitionInput,registry:registryInput,store,locks})};}
 return {directory,definition,adapter,registry,controls,calls,workflow,locks,observation,getActive:()=>active,getFence:()=>fence,
  changeSource:()=>{source.push({id:'user-2',value:'changed'});},changeDestination:()=>{destination!.push({id:'unexpected',value:'changed'});},changeDestinationIdentity:()=>{destinationIdentity=hash('foreign');},changeBackup:()=>{backupDigest=hash('foreign');},changeFence:()=>{fence={id:hash('foreign'),owner:'other'};},newWrites:()=>{writesAfter='present';},incompatible:()=>{compatible=false;}};
}
function action(state:Awaited<ReturnType<MigrationWorkflow['snapshot']>>){const {kind:_,...input}=state.pendingAction!;return input;}

test('migration records real phases, pauses across process at cutover, revalidates and retains original data without deletion',async t=>{
 const f=await fixture(t),first=f.workflow(),seen:string[]=[];first.workflow.subscribe(state=>seen.push(state.status));
 const gate=await first.workflow.start();assert.equal(gate.status,'waiting');assert.equal(gate.pendingAction?.kind,'cutover');assert.equal(f.getActive(),'source');assert.ok(f.getFence());
 assert.deepEqual(f.calls,['inspect','quiesce','backup','create','transfer','verify-data']);assert.equal(gate.checkpoint.verification?.passed,true);
 const reopened=new MigrationWorkflow({definition:f.definition,registry:f.registry,store:first.store,locks:f.locks});assert.deepEqual(await reopened.snapshot(),gate);
 const result=await reopened.cutover(action(gate));assert.equal(result.status,'passed');assert.equal(f.getActive(),'destination');assert.equal(f.getFence(),null);assert.equal(result.checkpoint.retained,true);
 assert.deepEqual(f.calls,['inspect','quiesce','backup','create','transfer','verify-data','cutover','verify-consumer','retain','resume']);
 for(const receipt of result.recordings){const loaded=await loadMigrationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:result.definitionDigest,executionId:result.executionId!});const snapshot=loaded.snapshot as {sharedState:unknown};const log=readStoredRecord(readRecordFile(receipt.tracePath).entries).root(receipt.runId)!;assert.equal(log.complete,true);assert.deepEqual(log.gaps,[]);assert.deepEqual(stateAt(log,log.commitLog.length-1).state,snapshot.sharedState);
  for(const path of [receipt.evidencePath,receipt.tracePath])for(const secret of ['/private/source','/private/destination','/private/dump.sqlite','retained-secret-row','SECRET-ADAPTER-EXCEPTION'])assert.equal((await readFile(path,'utf8')).includes(secret),false);
 }
 assert.deepEqual(await reopened.start(),result);assert.equal(f.calls.length,10);await assert.rejects(()=>reopened.cutover(action(gate)),/pending action/);
 assert.ok(seen.includes('running'));assert.equal(seen.includes('passed'),false,'first segment never publishes a premature completed migration');
});

test('entire protected plan capabilities and order are admitted before effects; second strategy/provider uses same workflow',async t=>{
 const f=await fixture(t),missing={...f.adapter,capabilities:f.adapter.capabilities.filter(cap=>cap!=='backup')};assert.throws(()=>f.workflow('unsupported',f.definition,{...f.registry,adapters:[missing]}),/every required/);assert.equal(f.calls.length,0);
 const alternate={...f.adapter,id:'tool-b',label:'Other provider',capabilities:[...f.adapter.capabilities,'transform-import']};const original=alternate.execute;alternate.execute=(step,request)=>original({...step,operation:step.operation==='transform-import'?'transfer':step.operation},request);
 const strategy={id:'custom-transfer',label:'Custom transfer',plan:(definition:MigrationDefinition)=>({steps:offlineTransferStrategy().plan(definition).steps.map(step=>step.phase==='transfer'?{...step,operation:'transform-import'}:step)})};
 const definition={...f.definition,strategyId:'custom-transfer',adapterId:'tool-b'},run=f.workflow('custom',definition,{strategies:[strategy],adapters:[alternate]});const gate=await run.workflow.start();assert.equal(gate.pendingAction?.kind,'cutover');assert.equal((await run.workflow.cutover(action(gate))).status,'passed');
});

test('every confirmed failure before cutover keeps source active and stops later provider effects',async t=>{
 for(const phase of ['inspect','quiesce','backup','create','transfer','verify-data'] as MigrationPhase[]){const f=await fixture(t);f.controls.fail=phase;const run=f.workflow(),state=await run.workflow.start();assert.equal(f.getActive(),'source');assert.equal(f.calls.at(-1),phase);assert.notEqual(state.status,'passed');assert.equal(state.pendingAction?.kind,phase==='inspect'?undefined:'recover');await assert.rejects(()=>run.workflow.start(),/already started/);}
});

test('manual pre-switch recovery verifies original and resumes its writes without switching or deleting',async t=>{
 const f=await fixture(t);f.controls.fail='transfer';f.adapter.capabilities=f.adapter.capabilities.filter(cap=>cap!=='recover-source');const run=f.workflow(),failed=await run.workflow.start();assert.equal(failed.pendingAction?.kind,'recover');
 const state=await run.workflow.recover(action(failed));assert.equal(state.status,'recovered');assert.equal(f.getActive(),'source');assert.equal(f.getFence(),null);assert.deepEqual(f.calls.slice(-2),['verify-recovery','resume-source']);assert.equal(f.calls.includes('cutover'),false);
});

test('gate rejects substituted source snapshot, backup, destination data/identity and fence after reopening',async t=>{
 for(const mutation of ['changeSource','changeBackup','changeDestination','changeDestinationIdentity','changeFence'] as const){const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();f[mutation]();const reopened=new MigrationWorkflow({definition:f.definition,registry:f.registry,store:run.store,locks:f.locks}),state=await reopened.cutover(action(gate));assert.equal(state.pendingAction?.kind,'inspect');assert.equal(f.getActive(),'source');assert.equal(f.calls.includes('cutover'),false);}
});

test('unknown effects or mismatched issued receipts require inspection and never retry or recover',async t=>{
 for(const mode of ['unknown','substitute'] as const){const f=await fixture(t);f.controls[mode]='transfer';const run=f.workflow(),state=await run.workflow.start();assert.equal(state.pendingAction?.kind,'inspect');assert.equal(f.calls.at(-1),'transfer');await assert.rejects(()=>run.workflow.recover(action(state)),/not safe/);await assert.rejects(()=>run.workflow.start(),/already started/);}
});

test('post-cutover failure can recover only with measured no-new-writes compatibility and explicit adapter capability',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();f.controls.fail='verify-consumer';const failed=await run.workflow.cutover(action(gate));assert.equal(f.getActive(),'destination');assert.equal(failed.pendingAction?.kind,'recover');f.controls.fail=undefined;const recovered=await run.workflow.recover(action(failed));assert.equal(recovered.status,'recovered');assert.equal(f.getActive(),'source');assert.deepEqual(f.calls.slice(-3),['recover-source','verify-recovery','resume-source']);
 for(const unsafe of ['newWrites','incompatible','no-capability'] as const){const other=await fixture(t);if(unsafe==='no-capability')other.adapter.capabilities=other.adapter.capabilities.filter(cap=>cap!=='recover-source');const attempt=other.workflow(),gate=await attempt.workflow.start();other.controls.fail='verify-consumer';if(unsafe!=='no-capability')other[unsafe]();const state=await attempt.workflow.cutover(action(gate));assert.equal(state.pendingAction?.kind,'inspect');assert.equal(other.getActive(),'destination');assert.ok(other.getFence());assert.equal(other.calls.includes('recover-source'),false);}
});

test('post-gate failures retain active identity and never execute downstream unsafe stages',async t=>{
 for(const phase of ['cutover','verify-consumer','retain','resume'] as MigrationPhase[]){const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();f.controls.fail=phase;const state=await run.workflow.cutover(action(gate));assert.notEqual(state.status,'passed');assert.equal(f.getActive(),'destination');assert.equal(f.calls.at(-1),phase);assert.equal(state.checkpoint.writesResumed,undefined);}
});

test('request tokens, definition substitutions and native summary tampering cannot authorize cutover',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();await assert.rejects(()=>run.workflow.cutover({...action(gate),token:'0'.repeat(64)}),/pending action/);
 const changed=new MigrationWorkflow({definition:{...f.definition,assessmentDigest:'f'.repeat(64)},registry:f.registry,store:run.store,locks:f.locks});await assert.rejects(()=>changed.snapshot(),/changed/);
 const receipt=gate.recordings[0]!,evidence=JSON.parse(await readFile(receipt.evidencePath,'utf8'));evidence.snapshot.sharedState.summary.checkpoint.sourceSnapshot='f'.repeat(64);await writeFile(receipt.evidencePath,JSON.stringify(evidence));await assert.rejects(()=>run.workflow.cutover(action(gate)),/replay differs/);assert.equal(f.calls.includes('cutover'),false);
});

test('shared source locks prevent overlapping attempts, while retained gates reject another execution fence',async t=>{
 const f=await fixture(t);let release!:()=>void,entered!:()=>void;f.controls.gate=new Promise<void>(resolve=>{release=resolve;});const starting=new Promise<void>(resolve=>{entered=resolve;});f.controls.entered=entered;const first=f.workflow('one'),running=first.workflow.start();await starting;
 const second=f.workflow('two');await assert.rejects(()=>second.workflow.start(),/locked/);release();const gate=await running;assert.equal(gate.pendingAction?.kind,'cutover');f.controls.gate=undefined;
 const third=f.workflow('three'),state=await third.workflow.start();assert.equal(state.pendingAction?.kind,'inspect');assert.equal(f.getActive(),'source');assert.equal(f.calls.filter(call=>call==='quiesce').length,1);
});

test('optional sealed assessment binds selected replacement, data knowledge and exact source scope before effects',async t=>{
 const {sealChangeAssessmentReport}=await import('../src/change-assessment/node.ts');const f=await fixture(t);
 const report=sealChangeAssessmentReport({kind:'change-assessment',schemaVersion:1,id:'review',label:'Replacement review',target:{id:'storage',scopeDigest:hash(f.definition.source.scope)},definitionDigest:'c'.repeat(64),executionId:'assessment-execution',assessedAt:Date.now(),changes:[{id:f.definition.changeId,label:'Data replacement',resourceId:f.definition.source.id,provider:'test-provider',adapterId:'probe',strategyId:'conservative',data:'stateful',previousDigest:'d'.repeat(64),desiredDigest:'e'.repeat(64),changedPaths:['/spec/schemaVersion'],disposition:'replace',reasons:['immutable-field'],validation:'declared-contract',observed:{exists:true,owned:true},requirements:['verified-backup','retain-original']}]});
 const definition={...f.definition,assessmentDigest:report.digest};
 assert.doesNotThrow(()=>new MigrationWorkflow({definition,assessment:report,registry:f.registry,store:new FileMigrationStore(join(f.directory,'report-bound')),locks:f.locks}));
 const {digest:_,...body}=report;
 for(const changed of [sealChangeAssessmentReport({...body,target:{...body.target,scopeDigest:'f'.repeat(64)}}),sealChangeAssessmentReport({...body,changes:body.changes.map(change=>({...change,data:'unknown'}))}),sealChangeAssessmentReport({...body,changes:body.changes.map(change=>({...change,disposition:'update'}))})]){
  assert.throws(()=>new MigrationWorkflow({definition:{...definition,assessmentDigest:changed.digest},assessment:changed,registry:f.registry,store:new FileMigrationStore(join(f.directory,'invalid-report')),locks:f.locks}),/does not match/);
 }
 assert.equal(f.calls.length,0);
});

test('a retained-source proof cannot disappear between verification and the manual switch',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start(),observe=f.adapter.observe;f.adapter.observe=async request=>({...await observe(request),sourceRetained:false});
 const reopened=new MigrationWorkflow({definition:f.definition,registry:f.registry,store:run.store,locks:f.locks}),state=await reopened.cutover(action(gate));
 assert.equal(state.pendingAction?.kind,'inspect');assert.equal(f.getActive(),'source');assert.equal(f.calls.includes('cutover'),false);
});

test('legitimate writes after resume do not turn a verified cutover into an uncertain failure or allow old-pointer replay',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();f.controls.writeAfterResume=true;
 const completed=await run.workflow.cutover(action(gate));assert.equal(completed.status,'passed');assert.equal(f.observation().writesAfterCutover,'present');assert.equal(f.getActive(),'destination');assert.equal(f.getFence(),null);
 assert.deepEqual(await run.workflow.snapshot(),completed);await assert.rejects(()=>run.workflow.recover(action(gate)),/not safe/);assert.equal(f.getActive(),'destination');
});

test('new writes while a recovery awaits approval and a failed recovery proof both stop further effects',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();f.controls.fail='verify-consumer';const recoverable=await run.workflow.cutover(action(gate));assert.equal(recoverable.pendingAction?.kind,'recover');f.newWrites();
 const stopped=await run.workflow.recover(action(recoverable));assert.equal(stopped.pendingAction?.kind,'inspect');assert.equal(f.calls.includes('recover-source'),false);assert.equal(f.getActive(),'destination');
 const other=await fixture(t);other.controls.fail='transfer';const attempt=other.workflow(),failed=await attempt.workflow.start();other.controls.fail='verify-recovery';const inspected=await attempt.workflow.recover(action(failed));assert.equal(inspected.pendingAction?.kind,'inspect');assert.equal(other.calls.includes('resume-source'),false);await assert.rejects(()=>attempt.workflow.recover(action(inspected)),/not safe/);
});

test('unrecognized trailing native trace entries cannot authorize a cutover',async t=>{
 const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start();await writeFile(gate.recordings[0]!.tracePath,'{"unrecognized":"entry"}\n',{flag:'a'});
 await assert.rejects(()=>run.workflow.cutover(action(gate)),/replay differs/);assert.equal(f.calls.includes('cutover'),false);
});

test('resource registration locks coordinate a resource used as one source and another destination',async t=>{
 const f=await fixture(t);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const first=f.locks.withLock(f.definition,async()=>{entered();await gate;});await started;
 const other={...f.definition,source:{...f.definition.destination,identity:hash('other-physical')},destination:{id:'third',scope:'third-scope'}};
 await assert.rejects(()=>f.locks.withLock(other,async()=>{}),/locked/);release();await first;
});

test('retained native progress and continuation segment labels cannot be substituted in the local ledger',async t=>{
 for(const kind of ['events','segment'] as const){const f=await fixture(t),run=f.workflow(),gate=await run.workflow.start(),state=structuredClone(gate);
  if(kind==='events')state.events[0]!.status='failed';else state.recordings[0]!.kind='cutover';await writeFile(run.store.path,JSON.stringify(state));
  await assert.rejects(()=>run.workflow.cutover(action(gate)),/differs|differ/);assert.equal(f.calls.includes('cutover'),false);
 }
});

test('backup proof must independently attest the fenced source snapshot even when its ID and digest match observation',async t=>{
 const f=await fixture(t),execute=f.adapter.execute;f.adapter.execute=async(step,request)=>{
  const receipt=await execute(step,request);if(step.phase==='backup'){const backup={...receipt.backup!,sourceSnapshot:hash('unrelated-data-snapshot')};return {...receipt,backup,observation:{...receipt.observation,backup}};}return receipt;
 };
 const run=f.workflow(),state=await run.workflow.start();assert.equal(state.pendingAction?.kind,'inspect');assert.equal(state.checkpoint.backup,undefined);assert.equal(f.calls.includes('create'),false);assert.equal(f.getActive(),'source');
 const other=await fixture(t),attempt=other.workflow(),gate=await attempt.workflow.start(),observe=other.adapter.observe;other.adapter.observe=async request=>{const measured=await observe(request);return {...measured,backup:{...measured.backup!,sourceSnapshot:hash('unrelated-data-snapshot')}};};
 const resumed=new MigrationWorkflow({definition:other.definition,registry:other.registry,store:attempt.store,locks:other.locks}),stopped=await resumed.cutover(action(gate));assert.equal(stopped.pendingAction?.kind,'inspect');assert.equal(other.calls.includes('cutover'),false);
});
