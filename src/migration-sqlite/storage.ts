import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { identifier, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import type { SqliteFence, SqliteOwner, SqlitePointer } from './types.ts';

const MAX_BYTES=8*1024*1024;
/** Private single-host filesystem ownership. It is not a distributed lease or protection from a privileged writer. */
export class SqliteOwnedStore {
  private static readonly queues=new Map<string,Promise<void>>();
  readonly directory:string;readonly id:string;readonly scope:string;private readonly locks:FileStateStore;
  constructor(directory:string,id:string){this.directory=resolve(directory);this.id=identifier(id,'SQLite consumer');this.scope=fingerprint({directory:this.directory,id});this.locks=new FileStateStore(join(this.directory,'locks'));}
  async root(create=false):Promise<void>{
    if(create)await mkdir(this.directory,{recursive:true,mode:0o700});
    const info=await lstat(this.directory);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||await realpath(this.directory)!==this.directory)throw Error('Use a canonical privately owned SQLite root');
  }
  async withLock<T>(work:()=>Promise<T>):Promise<T>{
    const previous=SqliteOwnedStore.queues.get(this.directory)??Promise.resolve();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),pending=previous.then(()=>gate);SqliteOwnedStore.queues.set(this.directory,pending);await previous;
    try{await this.root();return await this.locks.withLock('sqlite-consumer',work);}
    finally{release();if(SqliteOwnedStore.queues.get(this.directory)===pending)SqliteOwnedStore.queues.delete(this.directory);}
  }
  private bound(path:string):void{if(!resolve(path).startsWith(this.directory+'/')||resolve(path)===this.directory)throw Error('SQLite handles must remain under their owned root');}
  async readJson(path:string):Promise<unknown|undefined>{
    this.bound(path);
    try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES||(info.mode&0o077)!==0||await realpath(path)!==path)throw Error('Invalid private SQLite receipt');return jsonCopy(JSON.parse(await readFile(path,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  async writeJson(path:string,value:unknown):Promise<void>{
    this.bound(path);const bytes=JSON.stringify(jsonCopy(value),null,2)+'\n';if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('Bound private SQLite receipt');
    await mkdir(dirname(path),{recursive:true,mode:0o700});if(await realpath(dirname(path))!==dirname(path))throw Error('SQLite receipt directory changed');
    const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
    try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,path);await this.sync(dirname(path));}
    finally{await rm(temporary,{force:true});}
  }
  async sync(directory=this.directory):Promise<void>{const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
  ownerPath():string{return join(this.directory,'owner.json');}
  pointerPath():string{return join(this.directory,'active.json');}
  fencePath():string{return join(this.directory,'fence.json');}
  databasePath(id:string):string{return join(this.directory,'databases',identifier(id,'SQLite database')+'.sqlite');}
  backupPath(id:string):string{return join(this.directory,'backups',identifier(id,'SQLite backup')+'.sqlite');}
  runPath(id:string):string{return join(this.directory,'migrations',identifier(id,'SQLite migration execution')+'.json');}
  async owner():Promise<SqliteOwner>{
    await this.root();const value=await this.readJson(this.ownerPath()) as SqliteOwner|undefined,info=await lstat(this.directory);
    if(!value||value.version!==1||value.kind!=='sqlite-consumer-owner'||value.id!==this.id||typeof value.token!=='string'||!value.token
      ||value.rootIdentity!==fingerprint({scope:this.scope,dev:info.dev,ino:info.ino}))throw Error('SQLite root ownership changed');return value;
  }
  async pointer():Promise<SqlitePointer>{
    const owner=await this.owner(),value=await this.readJson(this.pointerPath()) as SqlitePointer|undefined;
    if(!value||value.version!==1||value.kind!=='sqlite-consumer-pointer'||value.owner!==owner.token||value.resourceId!==this.id
      ||!Number.isSafeInteger(value.schemaVersion)||value.schemaVersion<0||!Number.isSafeInteger(value.epoch)||value.epoch<1||typeof value.activationId!=='string')throw Error('SQLite consumer pointer changed');
    identifier(value.databaseId,'active SQLite database');return value;
  }
  async fence():Promise<SqliteFence|undefined>{
    const value=await this.readJson(this.fencePath()) as SqliteFence|undefined;if(!value)return;
    if(value.version!==1||value.kind!=='sqlite-write-fence'||typeof value.owner!=='string'||typeof value.migrationId!=='string'||!value.sourcePointer
      ||value.sourcePointer.owner!==(await this.owner()).token||!/^[a-f0-9]{64}$/.test(value.definitionDigest))throw Error('SQLite write fence changed');identifier(value.id,'SQLite fence');return value;
  }
  async reserveDatabase(path:string):Promise<void>{
    this.bound(path);await mkdir(dirname(path),{recursive:true,mode:0o700});if(await realpath(dirname(path))!==dirname(path))throw Error('SQLite database directory changed');
    const handle=await open(path,'wx',0o600);try{await handle.sync();}finally{await handle.close();}await this.sync(dirname(path));
  }
  async admitDatabase(path:string):Promise<void>{
    this.bound(path);for(const suffix of ['','-wal','-shm','-journal'])try{
      const location=path+suffix,info=await lstat(location);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024||(info.mode&0o077)!==0||await realpath(location)!==location)throw Error('SQLite file ownership or size changed');
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&suffix)continue;throw error;}
  }
  async privateDatabase(path:string):Promise<void>{await chmod(path,0o600);await this.admitDatabase(path);}
}
