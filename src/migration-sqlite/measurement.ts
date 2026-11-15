import { lstat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { jsonCopy } from '../graph/data.ts';
import { canonical, fingerprint } from '../util.ts';
import type { Json } from '../types.ts';
import { openSqlite, sqliteSequence } from './consumer.ts';
import type { SqliteInvariantProgram, SqliteMeasurement } from './types.ts';
import type { SqliteOwnedStore } from './storage.ts';

function encode(value:unknown):Json{
  if(typeof value==='bigint')return {sqliteInteger:value.toString()};if(value instanceof Uint8Array)return {sqliteBlob:Buffer.from(value).toString('base64')};
  if(Array.isArray(value))return value.map(encode);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));return jsonCopy(value);
}
function schemaVersion(database:DatabaseSync):number{const value=database.prepare('PRAGMA user_version').get()?.user_version;if(!Number.isSafeInteger(value)||Number(value)<0)throw Error('Invalid SQLite schema version');return Number(value);}
export async function measureSqlite(store:SqliteOwnedStore,path:string,invariants:SqliteInvariantProgram,readScope=true):Promise<SqliteMeasurement&{scope:Json}>{
  await store.admitDatabase(path);const owner=await store.owner(),info=await lstat(path),database=openSqlite(path,true);
  try{
    database.exec('BEGIN;');const integrity=database.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok'||database.prepare('PRAGMA foreign_key_check').get()!==undefined)throw Error('SQLite data integrity failed');
    let capturedBytes=0,capturedRows=0;const capture=(value:unknown):Json=>{const encoded=encode(value);capturedBytes+=Buffer.byteLength(canonical(encoded));if(++capturedRows>10_000||capturedBytes>4*1024*1024)throw Error('Bound SQLite record capture');return encoded;};
    const schema:Json[]=[];for(const row of database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").iterate()){if(schema.length>=2048)throw Error('Bound SQLite schema capture');schema.push(capture(row));}
    const tables:{name:string}[]=[];for(const row of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").iterate()){if(tables.length>=256)throw Error('Bound SQLite table capture');tables.push({name:String(row.name)});}
    const contents:Record<string,Json>={},counts:Record<string,number>={};
    for(const row of tables){const name=String(row.name),query=database.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"');query.setReadBigInts(true);
      const values:Json[]=[];for(const value of query.iterate())values.push(capture(value));values.sort((a,b)=>canonical(a).localeCompare(canonical(b)));counts[name]=values.length;contents[name]=values;
    }
    const scope=readScope?jsonCopy(invariants.read(database)):null,dataDigest=fingerprint(jsonCopy(contents)),scopeDigest=fingerprint(scope),schemaDigest=fingerprint(encode(schema)),sequence=sqliteSequence(database),version=schemaVersion(database);
    database.exec('COMMIT');return {identity:fingerprint({owner:owner.token,scope:store.scope,dev:info.dev,ino:info.ino}),snapshot:fingerprint({dataDigest,schemaDigest,sequence,schemaVersion:version}),
      dataDigest,scopeDigest,schemaDigest,sequence,schemaVersion:version,counts,scope};
  }catch{try{database.exec('ROLLBACK');}catch{}throw Error('SQLite data measurement did not confirm its registered invariants');}finally{database.close();}
}
