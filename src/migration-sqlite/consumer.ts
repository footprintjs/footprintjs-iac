import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { identifier, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import type { Json } from '../types.ts';
import { SqliteOwnedStore } from './storage.ts';
import type { SqliteConsumerOptions, SqlitePointer } from './types.ts';

export function openSqlite(path:string,readOnly=false):DatabaseSync{
  const database=new DatabaseSync(path,{readOnly,timeout:1000,enableForeignKeyConstraints:true,allowExtension:false});
  database.exec('PRAGMA trusted_schema=OFF;');return database;
}
export function sqliteSequence(database:DatabaseSync):number{
  const value=database.prepare('SELECT write_sequence FROM _footprint_consumer_state WHERE singleton=1').get()?.write_sequence;
  if(!Number.isSafeInteger(value)||Number(value)<0)throw Error('SQLite cooperative write sequence changed');return Number(value);
}
function admitSchema(database:DatabaseSync,pointer:SqlitePointer):void{if(database.prepare('PRAGMA user_version').get()?.user_version!==pointer.schemaVersion)throw Error('SQLite active schema differs from its consumer contract');}
/** Cooperating application access: every operation resolves the actual pointer and each write honors the same durable fence. */
export class OwnedSqliteConsumer {
  readonly store:SqliteOwnedStore;private readonly reads:Map<string,SqliteConsumerOptions['readPrograms'][number]>;private readonly writes:Map<string,SqliteConsumerOptions['writePrograms'][number]>;
  constructor(options:SqliteConsumerOptions){
    this.store=new SqliteOwnedStore(options.directory,options.id);this.reads=new Map();this.writes=new Map();
    for(const program of options.readPrograms){identifier(program.id,'SQLite read program');if(this.reads.has(program.id)||typeof program.run!=='function')throw Error('Register unique trusted SQLite readers');this.reads.set(program.id,{id:program.id,run:program.run.bind(program)});}
    for(const program of options.writePrograms){identifier(program.id,'SQLite write program');if(this.writes.has(program.id)||typeof program.run!=='function')throw Error('Register unique trusted SQLite writers');this.writes.set(program.id,{id:program.id,run:program.run.bind(program)});}
  }
  async initialize(options:{databaseId:string;schemaVersion:number;create(database:DatabaseSync):void}):Promise<void>{
    identifier(options.databaseId,'initial SQLite database');if(!Number.isSafeInteger(options.schemaVersion)||options.schemaVersion<1||options.schemaVersion>2147483647||typeof options.create!=='function')throw Error('Register a trusted initial schema');
    await this.store.root(true);await this.store.withLock(async()=>{
      if((await readdir(this.store.directory)).some(name=>name!=='locks'))throw Error('SQLite initialization requires a new empty owned root');
      const info=await lstat(this.store.directory),owner={version:1,kind:'sqlite-consumer-owner',id:this.store.id,token:randomUUID(),rootIdentity:fingerprint({scope:this.store.scope,dev:info.dev,ino:info.ino})};
      await this.store.writeJson(this.store.ownerPath(),owner);const path=this.store.databasePath(options.databaseId);await this.store.reserveDatabase(path);
      const database=openSqlite(path);try{database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
        options.create(database);database.exec('CREATE TABLE _footprint_consumer_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),write_sequence INTEGER NOT NULL); INSERT INTO _footprint_consumer_state VALUES(1,0); PRAGMA user_version='+options.schemaVersion+'; COMMIT;');
      }catch{try{database.exec('ROLLBACK');}catch{}throw Error('SQLite initial schema did not complete; inspect retained owned files');}finally{database.close();}
      await this.store.privateDatabase(path);const pointer:SqlitePointer={version:1,kind:'sqlite-consumer-pointer',owner:owner.token,resourceId:this.store.id,databaseId:options.databaseId,schemaVersion:options.schemaVersion,epoch:1,activationId:'initial'};
      await this.store.writeJson(this.store.pointerPath(),pointer);
    });
  }
  async read(programId:string,input:Json=null):Promise<Json>{
    const program=this.reads.get(programId);if(!program)throw Error('Choose a registered SQLite reader');const admitted=jsonCopy(input);
    return this.store.withLock(async()=>{const pointer=await this.store.pointer(),path=this.store.databasePath(pointer.databaseId);await this.store.admitDatabase(path);
      const database=openSqlite(path,true);try{admitSchema(database,pointer);return jsonCopy(program.run(database,admitted));}catch{throw Error('The registered SQLite read did not complete');}finally{database.close();}});
  }
  async write(programId:string,input:Json=null):Promise<Json>{
    const program=this.writes.get(programId);if(!program)throw Error('Choose a registered SQLite writer');const admitted=jsonCopy(input);
    return this.store.withLock(async()=>{
      await this.store.owner();if(await this.store.fence())throw Error('Application writes are paused by the durable SQLite migration fence');
      const pointer=await this.store.pointer(),path=this.store.databasePath(pointer.databaseId);await this.store.admitDatabase(path);const database=openSqlite(path);
      try{admitSchema(database,pointer);database.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');const before=sqliteSequence(database),result=jsonCopy(program.run(database,admitted));
        if(sqliteSequence(database)!==before)throw Error('Registered writer changed the cooperative sequence');database.prepare('UPDATE _footprint_consumer_state SET write_sequence=write_sequence+1 WHERE singleton=1').run();database.exec('COMMIT');return result;
      }catch{try{database.exec('ROLLBACK');}catch{}throw Error('The registered SQLite write did not complete');}finally{database.close();}
    });
  }
  async status():Promise<{databaseId:string;schemaVersion:number;epoch:number;writesPaused:boolean;sequence:number}>{
    return this.store.withLock(async()=>{const pointer=await this.store.pointer(),path=this.store.databasePath(pointer.databaseId);await this.store.admitDatabase(path);const database=openSqlite(path,true);
      try{admitSchema(database,pointer);return {databaseId:pointer.databaseId,schemaVersion:pointer.schemaVersion,epoch:pointer.epoch,writesPaused:!!await this.store.fence(),sequence:sqliteSequence(database)};}finally{database.close();}});
  }
}
