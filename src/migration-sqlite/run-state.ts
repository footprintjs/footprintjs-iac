import { canonical, fingerprint } from '../util.ts';
import { identifier, jsonCopy } from '../graph/data.ts';
import type { MigrationRequest, MigrationVerification } from '../migration/types.ts';
import type { SqliteFence, SqlitePointer } from './types.ts';
import type { SqliteOwnedStore } from './storage.ts';

export interface SqliteRunBinding {migrationId:string;executionId:string;definitionDigest:string;assessmentDigest:string;source:MigrationRequest['source'];destination:MigrationRequest['destination'];configurationDigest:string}
export interface SqliteRunState {
  version:1;kind:'sqlite-migration-run';binding:SqliteRunBinding;
  sourcePointer?:SqlitePointer;sourceSnapshot?:string;fence?:SqliteFence;
  backupId?:string;backupComplete?:boolean;destinationCreated?:boolean;transferred?:boolean;verification?:MigrationVerification;
  cutoverIntent?:SqlitePointer;cutover?:SqlitePointer;cutoverSequence?:number;consumerVerified?:boolean;sourceVerified?:boolean;retained?:boolean;resumed?:boolean;sourceResumed?:boolean;
}
export function sqliteRequest(input:MigrationRequest):MigrationRequest{
  const value=jsonCopy(input) as unknown as MigrationRequest;
  for(const key of ['executionId','operationId','migrationId'] as const)identifier(value[key],key);
  for(const key of ['definitionDigest','assessmentDigest'])if(!/^[a-f0-9]{64}$/.test(value[key as 'definitionDigest']))throw Error('Invalid SQLite migration request digest');
  if(!value.step||!value.source||!value.destination||!value.checkpoint)throw Error('Bind a complete SQLite migration request');
  return value;
}
export function sqliteRunBinding(request:MigrationRequest,configurationDigest:string):SqliteRunBinding{
  return {migrationId:request.migrationId,executionId:request.executionId,definitionDigest:request.definitionDigest,assessmentDigest:request.assessmentDigest,
    source:request.source,destination:request.destination,configurationDigest};
}
export async function loadSqliteRun(store:SqliteOwnedStore,request:MigrationRequest,configurationDigest:string):Promise<SqliteRunState>{
  const binding=sqliteRunBinding(request,configurationDigest),value=await store.readJson(store.runPath(request.executionId)) as SqliteRunState|undefined;
  if(value&&(value.version!==1||value.kind!=='sqlite-migration-run'||canonical(value.binding)!==canonical(binding)))throw Error('SQLite migration host or execution binding changed');
  return value??{version:1,kind:'sqlite-migration-run',binding};
}
export function saveSqliteRun(store:SqliteOwnedStore,state:SqliteRunState):Promise<void>{return store.writeJson(store.runPath(state.binding.executionId),state);}
export function sqliteBackupId(state:SqliteRunState):string{return 'backup-'+fingerprint(state.binding).slice(0,32);}
