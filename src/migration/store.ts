import { randomUUID } from 'node:crypto';
import { mkdir,open,readFile,rename,rm,stat } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { fingerprint } from '../util.ts';
import { readMigrationState } from './data.ts';
import type { MigrationDefinition,MigrationState } from './types.ts';
export class FileMigrationStore {
 readonly directory:string;readonly path:string;private readonly lock:FileStateStore;
 constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'migration.json');this.lock=new FileStateStore(join(this.directory,'locks'));}
 async load():Promise<MigrationState|undefined>{try{const info=await stat(this.path);if(!info.isFile()||info.size>16*1024*1024)throw Error('Migration ledger exceeds limits');return readMigrationState(JSON.parse(await readFile(this.path,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
 save(state:MigrationState):Promise<void>{return this.writeJson(this.path,readMigrationState(state));}
 async writeJson(path:string,value:unknown):Promise<void>{if(dirname(resolve(path))!==this.directory)throw Error('Migration evidence left its private store');const bytes=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('Migration evidence exceeds limits');await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,path);const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}}finally{await rm(temporary,{force:true});}}
 withLock<T>(work:()=>Promise<T>):Promise<T>{return this.lock.withLock('migration',work);}
}
/** Share across attempts on the same host. The provider fence also protects manual gates. */
export class FileMigrationLocks {
 private readonly locks:FileStateStore;
 constructor(directory:string){this.locks=new FileStateStore(resolve(directory));}
 withLock<T>(definition:MigrationDefinition,work:()=>Promise<T>):Promise<T>{
  const keys=[...new Set([fingerprint({physicalIdentity:definition.source.identity}),fingerprint({resource:{id:definition.source.id,scope:definition.source.scope}}),fingerprint({resource:definition.destination})])].sort();
  const locked=(index:number):Promise<T>=>index===keys.length?work():this.locks.withLock(keys[index]!,()=>locked(index+1));return locked(0);
 }
}
