import { lstat } from 'node:fs/promises';
import { canonical, fingerprint } from '../util.ts';
import type { MigrationDataIdentity, MigrationObservation } from '../migration/types.ts';
import { measureSqlite } from './measurement.ts';
import type { SqliteMigrationContext } from './context.ts';
import type { SqliteMeasurement } from './types.ts';

async function exists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
export function sqliteIdentity(id:string,scope:string,measurement:SqliteMeasurement):MigrationDataIdentity{return {id,scope,identity:measurement.identity,snapshot:measurement.snapshot};}
export async function sqliteObservation(context:SqliteMigrationContext):Promise<MigrationObservation>{
  const {options,state,request}=context,store=options.consumer.store,source=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants),pointer=await store.pointer(),fence=await store.fence();
  const sourceIdentity=sqliteIdentity(options.sourceDatabaseId,store.scope,source);
  if(sourceIdentity.identity!==request.source.identity)throw Error('SQLite original source identity changed');
  const destination=await exists(store.databasePath(options.targetDatabaseId))?await measureSqlite(store,store.databasePath(options.targetDatabaseId),options.invariants,false):undefined;
  const backup=state.backupId&&await exists(store.backupPath(state.backupId))?await measureSqlite(store,store.backupPath(state.backupId),options.invariants):undefined;
  const active=pointer.databaseId===options.sourceDatabaseId?'source':pointer.databaseId===options.targetDatabaseId?'destination':'unknown';
  const writesAfterCutover=active==='source'&&!state.cutoverIntent?'none':active==='destination'&&state.cutoverSequence!==undefined&&destination
    ?destination.sequence>state.cutoverSequence?'present':destination.sequence===state.cutoverSequence?'none':'unknown':'unknown';
  return {source:sourceIdentity,...(destination?{destination:sqliteIdentity(options.targetDatabaseId,store.scope,destination)}:{}),
    ...(backup&&state.backupComplete?{backup:{id:state.backupId!,digest:fingerprint({identity:backup.identity,snapshot:backup.snapshot}),sourceSnapshot:backup.snapshot}}:{}),
    fence:fence?{id:fence.id,owner:fence.owner}:null,active,writesAfterCutover,sourceRetained:true,rollbackCompatible:false};
}
export async function assertSqliteFence(context:SqliteMigrationContext):Promise<void>{
  const {options,state,request}=context,store=options.consumer.store,fence=await store.fence();
  if(!state.fence||!fence||canonical(fence)!==canonical(state.fence)||fence.owner!==request.executionId||fence.migrationId!==request.migrationId||fence.definitionDigest!==request.definitionDigest)throw Error('The exact durable SQLite write fence is required');
  if(request.checkpoint.fence&&canonical(request.checkpoint.fence)!==canonical({id:fence.id,owner:fence.owner}))throw Error('SQLite checkpoint fence differs from its owned fence');
  const observation=await sqliteObservation(context);
  if(!state.sourceSnapshot||observation.source.snapshot!==state.sourceSnapshot||request.checkpoint.sourceSnapshot&&request.checkpoint.sourceSnapshot!==state.sourceSnapshot)throw Error('SQLite source changed after writes were paused');
  if(request.checkpoint.backup&&canonical(observation.backup)!==canonical(request.checkpoint.backup))throw Error('SQLite backup changed after verification');
  if(request.checkpoint.destination&&canonical(observation.destination)!==canonical(request.checkpoint.destination))throw Error('SQLite candidate changed after verification');
}
