import { rm } from 'node:fs/promises';
import { canonical } from '../util.ts';
import { assertSqliteFence, sqliteObservation } from './observations.ts';
import { measureSqlite } from './measurement.ts';
import { saveSqliteRun } from './run-state.ts';
import type { SqliteMigrationContext } from './context.ts';

export async function cutoverSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state,request}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.verification?.passed||!request.checkpoint.verification||canonical(request.checkpoint.verification)!==canonical(state.verification)
    ||state.cutoverIntent||!state.sourcePointer||canonical(await store.pointer())!==canonical(state.sourcePointer))throw Error('SQLite cutover requires its exact verified checkpoint and active source');
  const destination=await measureSqlite(store,store.databasePath(options.targetDatabaseId),options.invariants);
  if(destination.snapshot!==state.verification.destinationSnapshot||state.sourceSnapshot!==state.verification.sourceSnapshot)throw Error('SQLite verified data changed before cutover');
  state.cutoverIntent={...state.sourcePointer,databaseId:options.targetDatabaseId,schemaVersion:options.targetSchemaVersion,epoch:state.sourcePointer.epoch+1,activationId:request.executionId};
  state.cutoverSequence=destination.sequence;await saveSqliteRun(store,state);
  await store.writeJson(store.pointerPath(),state.cutoverIntent);state.cutover=await store.pointer();
  if(canonical(state.cutover)!==canonical(state.cutoverIntent))throw Error('SQLite active consumer pointer did not switch exactly');await saveSqliteRun(store,state);
}
export async function retainSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context;await assertSqliteFence(context);const observation=await sqliteObservation(context);
  if(observation.active!=='destination'||!observation.backup||!observation.sourceRetained||!state.consumerVerified)throw Error('Retain original and backup only after the consumer was verified');
  state.retained=true;await saveSqliteRun(options.consumer.store,state);
}
export async function resumeSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.cutover||!state.consumerVerified||!state.retained||canonical(await store.pointer())!==canonical(state.cutover))throw Error('Resume writes only for the verified active candidate');
  await rm(store.fencePath());await store.sync();state.resumed=true;await saveSqliteRun(store,state);
}
export async function resumeSqliteSource(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.sourceVerified||state.cutoverIntent||state.cutover||!state.sourcePointer||canonical(await store.pointer())!==canonical(state.sourcePointer))throw Error('SQLite adapter never rolls a switched consumer back to the old database');
  await rm(store.fencePath());await store.sync();state.sourceResumed=true;await saveSqliteRun(store,state);
}
