import type { MigrationRequest } from '../migration/types.ts';
import type { OwnedSqliteConsumer } from './consumer.ts';
import type { SqliteInvariantProgram, SqliteMigrationProgram } from './types.ts';
import type { SqliteRunState } from './run-state.ts';

export interface SqliteMigrationAdapterOptions {
  id:string;label:string;consumer:OwnedSqliteConsumer;sourceDatabaseId:string;targetDatabaseId:string;sourceSchemaVersion:number;targetSchemaVersion:number;
  migration:SqliteMigrationProgram;invariants:SqliteInvariantProgram;
  verifyConsumer:{id:string;digest:string;run(consumer:OwnedSqliteConsumer):Promise<boolean>};
  /** Optional independent original-contract probe; required to offer pre-switch write resumption. */
  verifySource?:{id:string;digest:string;run(consumer:OwnedSqliteConsumer):Promise<boolean>};
}
export interface SqliteMigrationContext {options:SqliteMigrationAdapterOptions;configurationDigest:string;request:MigrationRequest;state:SqliteRunState}
