import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../types.ts';

export interface SqliteReadProgram { id:string; run(database:DatabaseSync,input:Json):Json }
export interface SqliteWriteProgram { id:string; run(database:DatabaseSync,input:Json):Json }
/** Registered functions are trusted host code; no browser request supplies SQL or a file location. */
export interface SqliteConsumerOptions { id:string;directory:string;readPrograms:readonly SqliteReadProgram[];writePrograms:readonly SqliteWriteProgram[] }
export interface SqlitePointer { version:1;kind:'sqlite-consumer-pointer';owner:string;resourceId:string;databaseId:string;schemaVersion:number;epoch:number;activationId:string }
export interface SqliteFence { version:1;kind:'sqlite-write-fence';id:string;owner:string;migrationId:string;definitionDigest:string;sourcePointer:SqlitePointer }
export interface SqliteOwner { version:1;kind:'sqlite-consumer-owner';id:string;token:string;rootIdentity:string }
export interface SqliteMigrationProgram {id:string;digest:string;run(database:DatabaseSync):void}
export interface SqliteInvariantProgram {
  id:string;digest:string;
  /** Select and order every preserved field; throw if any required domain invariant fails. */
  read(database:DatabaseSync):Json;
}
export interface SqliteMeasurement {
  identity:string;snapshot:string;schemaDigest:string;dataDigest:string;scopeDigest:string;
  schemaVersion:number;sequence:number;counts:Record<string,number>;
}
