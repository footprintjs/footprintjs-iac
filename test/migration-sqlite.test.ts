import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { MigrationWorkflow, FileMigrationLocks, FileMigrationStore, offlineTransferStrategy, loadMigrationRecording, type MigrationAdapter, type MigrationDefinition, type MigrationState } from '../src/migration/node.ts';
import { createSqliteConversationFixture, conversationMigrationV2, type SqliteMigrationProgram } from '../src/migration-sqlite/index.ts';
import { fingerprint } from '../src/util.ts';
import type { Json } from '../src/types.ts';

function action(state:MigrationState){assert.ok(state.pendingAction);const {executionId,token,checkpointDigest}=state.pendingAction;return {executionId,token,checkpointDigest};}
async function fixture(t:{after(fn:()=>Promise<void>):void},options:{migration?:SqliteMigrationProgram}={}){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'iac-sqlite-migration-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const open=()=>createSqliteConversationFixture({directory:join(directory,'owned-app'),...options}),app=await open(),resources=await app.adapter.resources();
  const definition:MigrationDefinition={version:1,id:'conversation-v2',label:'Preserve conversation data',assessmentDigest:'a'.repeat(64),changeId:'conversation-schema',configurationDigest:app.adapter.configurationDigest,
    ...resources,strategyId:'offline-transfer',adapterId:app.adapter.id};
  const store=new FileMigrationStore(join(directory,'workflow'));
  const workflow=(adapter:MigrationAdapter=app.adapter)=>new MigrationWorkflow({definition,registry:{strategies:[offlineTransferStrategy()],adapters:[adapter]},store,locks:new FileMigrationLocks(join(directory,'migration-locks'))});
  return {directory,app,open,definition,store,workflow};
}
function mutate(path:string,sql:string):void{const database=new DatabaseSync(path);try{database.exec(sql);}finally{database.close();}}

test('real SQLite backup, candidate schema migration, exact data preservation and resumed consumer survive a fresh host instance',async t=>{
  const f=await fixture(t);await f.app.appendExampleMessage();const before=await f.app.consumer.read('records');
  const prepared=await f.workflow().start();assert.equal(prepared.status,'waiting');assert.equal(prepared.pendingAction!.kind,'cutover');assert.equal(prepared.checkpoint.verification!.passed,true);assert.equal(prepared.checkpoint.backup!.sourceSnapshot,prepared.checkpoint.sourceSnapshot);
  assert.deepEqual(await f.app.readSummary(),{databaseId:'conversations-v1',schemaVersion:1,epoch:1,writesPaused:true,sequence:1,users:2,conversations:2,messages:4});
  await assert.rejects(()=>f.app.appendExampleMessage(),/paused/);
  const sourcePath=f.app.consumer.store.databasePath('conversations-v1'),backupPath=f.app.consumer.store.backupPath(prepared.checkpoint.backup!.id),candidatePath=f.app.consumer.store.databasePath('conversations-v2');
  for(const path of [sourcePath,backupPath,candidatePath])assert.equal((await readFile(path)).subarray(0,16).toString('utf8'),'SQLite format 3\u0000');
  const reopened=await f.open(),continued=f.workflow(reopened.adapter),complete=await continued.cutover(action(prepared));assert.equal(complete.status,'passed');
  assert.equal(complete.checkpoint.switched,true);assert.equal(complete.checkpoint.consumerVerified,true);assert.equal(complete.checkpoint.retained,true);assert.equal(complete.checkpoint.writesResumed,true);
  assert.deepEqual(await reopened.consumer.read('records'),before);assert.equal((await reopened.readSummary()).databaseId,'conversations-v2');assert.equal((await reopened.readSummary()).schemaVersion,2);
  const appended=await reopened.appendExampleMessage(),after=await reopened.consumer.read('records') as {messages:{id:string}[]};
  assert.equal(after.messages.length,5);assert.ok(after.messages.some(row=>row.id===appended.id));
  assert.deepEqual({...after,messages:after.messages.filter(row=>row.id!==appended.id)},before,'all original values and identifiers survive, not just counts');
  assert.deepEqual(await continued.start(),complete,'completed workflow replay never overwrites the now-active database');
  assert.equal((await reopened.consumer.read('records') as {messages:Json[]}).messages.length,5);
  for(const path of [sourcePath,backupPath]){const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get()!.count,4);}finally{db.close();}}
  assert.equal(complete.recordings.length,2);
  for(const receipt of complete.recordings){
    const native=await loadMigrationRecording(receipt.evidencePath,{runId:receipt.runId}),log=readStoredRecord(readRecordFile(receipt.tracePath).entries).root(receipt.runId)!;
    assert.equal(log.complete,true);assert.deepEqual(log.gaps,[]);assert.deepEqual(stateAt(log,log.commitLog.length-1).state,(native.snapshot as {sharedState:unknown}).sharedState);
    for(const path of [receipt.evidencePath,receipt.tracePath]){const bytes=await readFile(path,'utf8');assert.equal(bytes.includes('Private π conversation'),false);assert.equal(bytes.includes(sourcePath),false);assert.equal(bytes.includes('ALTER TABLE messages'),false);}
  }
});

test('same row counts cannot hide changed messages; failed pre-switch migration keeps original data and manually resumes only its source',async t=>{
  const corrupt:SqliteMigrationProgram={id:'corrupt-message-test',digest:fingerprint({version:1,change:'same-count-content-corruption'}),run(database){conversationMigrationV2.run(database);database.exec("UPDATE messages SET body='changed without changing row count' WHERE id='message-alice-1'");}};
  const f=await fixture(t,{migration:corrupt}),before=await f.app.consumer.read('records'),failed=await f.workflow().start();
  assert.equal(failed.status,'waiting');assert.equal(failed.pendingAction!.kind,'recover');assert.equal(failed.operations.find(operation=>operation.phase==='verify-data')!.status,'failed');
  assert.deepEqual(await f.app.consumer.read('records'),before);assert.equal((await f.app.readSummary()).databaseId,'conversations-v1');assert.equal((await f.app.readSummary()).writesPaused,true);
  const recovered=await f.workflow().recover(action(failed));assert.equal(recovered.status,'recovered');assert.equal((await f.app.readSummary()).writesPaused,false);
  assert.deepEqual(await f.app.consumer.read('records'),before);await f.app.appendExampleMessage();assert.equal((await f.app.readSummary()).messages,4);
  assert.ok(await readFile(f.app.consumer.store.backupPath(failed.checkpoint.backup!.id)));assert.ok(await readFile(f.app.consumer.store.databasePath('conversations-v2')));
});

test('gate revalidation rejects changed source, backup, candidate and foreign fence across process-style reopen',async t=>{
  for(const changed of ['source','backup','candidate','fence'] as const){
    const f=await fixture(t),prepared=await f.workflow().start();assert.equal(prepared.pendingAction!.kind,'cutover');
    if(changed==='fence'){
      const fence=await f.app.consumer.store.fence();await f.app.consumer.store.writeJson(f.app.consumer.store.fencePath(),{...fence,id:'foreign-fence'});
    }else{
      const path=changed==='source'?f.app.consumer.store.databasePath('conversations-v1'):changed==='candidate'?f.app.consumer.store.databasePath('conversations-v2'):f.app.consumer.store.backupPath(prepared.checkpoint.backup!.id);
      mutate(path,"UPDATE messages SET body='external write after verification' WHERE id='message-alice-1'");
    }
    const reopened=await f.open(),blocked=await f.workflow(reopened.adapter).cutover(action(prepared));
    assert.equal(blocked.status,'waiting');assert.equal(blocked.pendingAction!.kind,'inspect');assert.notEqual(blocked.checkpoint.switched,true);assert.equal((await reopened.consumer.store.pointer()).databaseId,'conversations-v1');
    assert.equal(blocked.operations.filter(operation=>operation.phase==='cutover').length,0,'no pointer effect follows failed gate revalidation');
  }
});

test('post-switch failure retains new application writes and never permits a blind rollback to the original database',async t=>{
  const f=await fixture(t);let writtenId:string|undefined;
  const faultAfterResume:MigrationAdapter={...f.app.adapter,async execute(step,request){
    const receipt=await f.app.adapter.execute(step,request);
    if(step.phase==='resume'&&receipt.status==='succeeded'){
      writtenId=(await f.app.appendExampleMessage()).id;
      return {...receipt,status:'failed',observation:await f.app.adapter.observe(request)};
    }
    return receipt;
  }};
  const prepared=await f.workflow(faultAfterResume).start(),failed=await f.workflow(faultAfterResume).cutover(action(prepared));
  assert.equal(failed.status,'waiting');assert.equal(failed.pendingAction!.kind,'inspect');assert.equal(failed.checkpoint.switched,true);
  assert.equal((await f.app.readSummary()).databaseId,'conversations-v2');assert.equal((await f.app.readSummary()).writesPaused,false);
  const resumed=failed.operations.find(operation=>operation.phase==='resume')!;assert.equal(resumed.receipt!.observation.writesAfterCutover,'present');
  assert.ok((await f.app.consumer.read('records') as {messages:{id:string}[]}).messages.some(row=>row.id===writtenId));
  await assert.rejects(()=>f.workflow(faultAfterResume).recover(action(failed)),/not safe|pending action/);
  const later=(await f.app.appendExampleMessage()).id;const records=await f.app.consumer.read('records') as {messages:{id:string}[]};assert.ok(records.messages.some(row=>row.id===later));assert.ok(records.messages.some(row=>row.id===writtenId));
  const request=resumed.request;await assert.rejects(()=>f.app.adapter.execute({id:'recover-source',phase:'recover-source',operation:'recover-source'},
    {...request,step:{id:'recover-source',phase:'recover-source',operation:'recover-source'}}),/bound native step/);
  assert.equal((await f.app.consumer.store.pointer()).databaseId,'conversations-v2');
});

test('host program contract changes and unregistered consumer programs cannot bypass the durable fence',async t=>{
  const f=await fixture(t),prepared=await f.workflow().start();
  await assert.rejects(()=>f.app.consumer.write('DROP TABLE messages'),/registered/);await assert.rejects(()=>f.app.consumer.read('../databases/conversations-v1.sqlite'),/registered/);
  const changed=await createSqliteConversationFixture({directory:f.app.directory,migration:{...conversationMigrationV2,digest:'f'.repeat(64)}});
  assert.throws(()=>f.workflow(changed.adapter),/host configuration/);assert.equal((await f.app.readSummary()).writesPaused,true);
  await assert.rejects(()=>f.workflow().cutover({...action(prepared),checkpointDigest:'0'.repeat(64)}),/pending action/);assert.equal((await f.app.consumer.store.pointer()).databaseId,'conversations-v1');
});

test('a different Node process reopens the durable manual gate and actual consumer writes follow its atomic pointer',async t=>{
  const f=await fixture(t),before=await f.app.consumer.read('records'),prepared=await f.workflow().start();assert.equal(prepared.pendingAction!.kind,'cutover');
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
    import {join} from 'node:path';
    import {createSqliteConversationFixture} from './src/migration-sqlite/index.ts';
    import {MigrationWorkflow,FileMigrationStore,FileMigrationLocks,offlineTransferStrategy} from './src/migration/node.ts';
    const root=process.argv[1],app=await createSqliteConversationFixture({directory:join(root,'owned-app')});
    const store=new FileMigrationStore(join(root,'workflow')),saved=await store.load();
    const workflow=new MigrationWorkflow({definition:saved.definition,registry:{strategies:[offlineTransferStrategy()],adapters:[app.adapter]},store,locks:new FileMigrationLocks(join(root,'migration-locks'))});
    const {executionId,token,checkpointDigest}=saved.pendingAction;
    const result=await workflow.cutover({executionId,token,checkpointDigest});
    const appended=await app.appendExampleMessage();
    process.stdout.write(JSON.stringify({status:result.status,id:appended.id,summary:await app.readSummary()}));
  `,f.directory],{encoding:'utf8',cwd:process.cwd(),timeout:30000});
  const result=JSON.parse(output) as {status:string;id:string;summary:{schemaVersion:number;messages:number}};
  assert.equal(result.status,'passed');assert.equal(result.summary.schemaVersion,2);assert.equal(result.summary.messages,4);
  const after=await f.app.consumer.read('records') as {messages:{id:string}[]};assert.deepEqual({...after,messages:after.messages.filter(message=>message.id!==result.id)},before);
  assert.equal((await f.app.consumer.store.pointer()).databaseId,'conversations-v2');
});

test('SQLite capture is bounded before bulk materialization and consumer message values remain bound parameters',async t=>{
  const f=await fixture(t),injection="'); DROP TABLE users; --";
  await f.app.consumer.write('append-message',{id:'message-quoted',conversationId:'conversation-alice',userId:'user-alice',body:injection,createdAt:'2026-01-03T00:00:00Z'});
  assert.equal((await f.app.readSummary()).users,2);assert.ok((await f.app.consumer.read('records') as {messages:{body:string}[]}).messages.some(row=>row.body===injection));
  const source=new DatabaseSync(f.app.consumer.store.databasePath('conversations-v1'));
  try{source.exec('BEGIN');const insert=source.prepare('INSERT INTO messages(id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)');for(let index=0;index<10_010;index++)insert.run('bulk-'+index,'conversation-alice','user-alice','bounded data','2026-01-04T00:00:00Z');source.exec('COMMIT');}finally{source.close();}
  await assert.rejects(()=>f.app.adapter.inspectSource(),/measurement/);assert.equal((await f.app.readSummary()).writesPaused,false);assert.equal((await f.app.consumer.store.pointer()).databaseId,'conversations-v1');
});

test('a real foreign-key violation blocks SQLite measurement before any migration fence or pointer change',async t=>{
  const f=await fixture(t),source=new DatabaseSync(f.app.consumer.store.databasePath('conversations-v1'),{enableForeignKeyConstraints:false});
  try{source.prepare('INSERT INTO messages(id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)').run('orphan-message','absent-conversation','user-alice','Unmanaged invalid source record','2026-01-05T00:00:00Z');}finally{source.close();}
  await assert.rejects(()=>f.app.adapter.inspectSource(),/measurement/);assert.equal((await f.app.consumer.store.pointer()).databaseId,'conversations-v1');assert.equal(await f.app.consumer.store.fence(),undefined);
});
