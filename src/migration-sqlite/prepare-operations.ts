import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { canonical, fingerprint } from '../util.ts';
import { openSqlite, sqliteSequence } from './consumer.ts';
import { measureSqlite } from './measurement.ts';
import { assertSqliteFence, sqliteObservation } from './observations.ts';
import { saveSqliteRun, sqliteBackupId } from './run-state.ts';
import type { SqliteMigrationContext } from './context.ts';
import type { SqliteFence } from './types.ts';

export async function quiesceSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state,request}=context,store=options.consumer.store,pointer=await store.pointer();
  if(pointer.databaseId!==options.sourceDatabaseId||pointer.schemaVersion!==options.sourceSchemaVersion||state.fence||await store.fence())throw Error('Pause only an unfenced active SQLite source');
  state.sourcePointer=pointer;state.fence={version:1,kind:'sqlite-write-fence',id:randomUUID(),owner:request.executionId,migrationId:request.migrationId,definitionDigest:request.definitionDigest,sourcePointer:pointer} satisfies SqliteFence;
  await saveSqliteRun(store,state);await store.writeJson(store.fencePath(),state.fence);
  const source=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants);if(source.schemaVersion!==options.sourceSchemaVersion)throw Error('SQLite source schema changed before its fence snapshot');state.sourceSnapshot=source.snapshot;
  await saveSqliteRun(store,state);
}
export async function backupSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(state.backupId)throw Error('This SQLite backup already has a retained or uncertain outcome');
  state.backupId=sqliteBackupId(state);state.backupComplete=false;await saveSqliteRun(store,state);
  const destination=store.backupPath(state.backupId);await store.reserveDatabase(destination);const source=openSqlite(store.databasePath(options.sourceDatabaseId),true);
  try{await backup(source,destination,{rate:64});}finally{source.close();}
  await store.privateDatabase(destination);const measurement=await measureSqlite(store,destination,options.invariants);
  if(measurement.snapshot!==state.sourceSnapshot)throw Error('SQLite backup does not match the fenced source snapshot');
  state.backupComplete=true;await saveSqliteRun(store,state);await assertSqliteFence(context);
}
export async function createSqliteCandidate(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.backupComplete||state.destinationCreated)throw Error('Create a fresh candidate after a verified SQLite backup');
  const path=store.databasePath(options.targetDatabaseId);await store.reserveDatabase(path);const database=openSqlite(path);
  try{database.exec('PRAGMA synchronous=FULL; CREATE TABLE _footprint_consumer_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),write_sequence INTEGER NOT NULL); INSERT INTO _footprint_consumer_state VALUES(1,0);');}finally{database.close();}
  state.destinationCreated=true;await saveSqliteRun(store,state);
}
export async function transferSqlite(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.backupComplete||!state.destinationCreated||state.transferred)throw Error('Transfer only the recorded backup to its fresh SQLite candidate');
  const source=openSqlite(store.backupPath(state.backupId!),true),path=store.databasePath(options.targetDatabaseId);
  try{await backup(source,path,{rate:64});}finally{source.close();}
  await store.privateDatabase(path);const database=openSqlite(path);
  try{
    database.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');const sequence=sqliteSequence(database);options.migration.run(database);
    if(sqliteSequence(database)!==sequence)throw Error('Migration changed the application write sequence');
    database.exec('PRAGMA user_version='+options.targetSchemaVersion+'; COMMIT;');
  }catch{try{database.exec('ROLLBACK');}catch{}throw Error('The registered SQLite schema migration did not complete');}finally{database.close();}
  state.transferred=true;await saveSqliteRun(store,state);
}
export async function verifySqliteData(context:SqliteMigrationContext):Promise<void>{
  const {options,state}=context,store=options.consumer.store;await assertSqliteFence(context);
  if(!state.transferred||!state.backupComplete)throw Error('Verify a transferred SQLite candidate');
  const source=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants),backupCopy=await measureSqlite(store,store.backupPath(state.backupId!),options.invariants),destination=await measureSqlite(store,store.databasePath(options.targetDatabaseId),options.invariants);
  const passed=source.snapshot===backupCopy.snapshot&&canonical(source.scope)===canonical(backupCopy.scope)&&canonical(source.scope)===canonical(destination.scope)
    &&destination.sequence===source.sequence&&destination.schemaVersion===options.targetSchemaVersion;
  state.verification={id:options.invariants.id,digest:fingerprint({program:{id:options.invariants.id,digest:options.invariants.digest},
    sourceSnapshot:source.snapshot,destinationSnapshot:destination.snapshot,sourceScope:source.scopeDigest,destinationScope:destination.scopeDigest,passed}),
    passed,sourceSnapshot:source.snapshot,destinationSnapshot:destination.snapshot};await saveSqliteRun(store,state);
}
