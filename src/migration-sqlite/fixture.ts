import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fingerprint } from '../util.ts';
import { OwnedSqliteConsumer } from './consumer.ts';
import { createSqliteMigrationAdapter } from './adapter.ts';
import { conversationInvariants, conversationMigrationV2, conversationReadPrograms, conversationWritePrograms, createConversationV1 } from './conversation-programs.ts';
import type { SqliteInvariantProgram, SqliteMigrationProgram } from './types.ts';
import type { SqliteMigrationAdapterOptions } from './context.ts';

/** A real local database example with an explicit cooperating consumer. It is independent of Neo and cloud services. */
export async function createSqliteConversationFixture(options:{directory:string;id?:string;migration?:SqliteMigrationProgram;invariants?:SqliteInvariantProgram;verifyConsumer?:SqliteMigrationAdapterOptions['verifyConsumer']}){
  const requested=resolve(options.directory);await mkdir(dirname(requested),{recursive:true,mode:0o700});const directory=join(await realpath(dirname(requested)),basename(requested));
  const consumer=new OwnedSqliteConsumer({id:options.id??'conversation-app',directory,readPrograms:conversationReadPrograms,writePrograms:conversationWritePrograms});
  let initialized=false;try{await lstat(consumer.store.ownerPath());initialized=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!initialized)await consumer.initialize({databaseId:'conversations-v1',schemaVersion:1,create:createConversationV1});else{await consumer.store.owner();await consumer.store.pointer();}
  const adapterOptions:SqliteMigrationAdapterOptions={id:'sqlite-conversation-replacement',label:'Owned local SQLite replacement',consumer,sourceDatabaseId:'conversations-v1',targetDatabaseId:'conversations-v2',sourceSchemaVersion:1,targetSchemaVersion:2,
    migration:options.migration??conversationMigrationV2,invariants:options.invariants??conversationInvariants,verifySource:{id:'conversation-app-v1-health',digest:fingerprint({version:1,program:'read-v1-records-through-active-consumer-pointer'}),async run(app){
      const summary=await app.read('summary') as {schemaVersion:number;users:number;conversations:number;messages:number};await app.read('records');return summary.schemaVersion===1&&summary.users===2&&summary.conversations===2&&summary.messages>=3;
    }},verifyConsumer:options.verifyConsumer??{id:'conversation-app-v2-health',digest:fingerprint({version:1,program:'read-v2-health-through-active-consumer-pointer'}),async run(app){
      const data=await app.read('v2-health') as {schemaVersion:number;stored:number;messages:number};return data.schemaVersion===2&&data.messages>=3&&data.stored===data.messages;
    }}};
  const adapter=createSqliteMigrationAdapter(adapterOptions);
  return {directory,consumer,adapter,adapterOptions,
    async readSummary(){const counts=await consumer.read('summary') as {schemaVersion:number;users:number;conversations:number;messages:number};return {...await consumer.status(),...counts};},
    async appendExampleMessage(){const id='message-'+randomUUID();await consumer.write('append-message',{id,conversationId:'conversation-alice',userId:'user-alice',body:'Message written through the cooperating consumer',createdAt:new Date().toISOString()});return {id,...await consumer.status()};},
  };
}
