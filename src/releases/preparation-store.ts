import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { readReleasePreparationState } from './preparation-data.ts';
import type { ReleasePreparationState } from './preparation-types.ts';

const MAX_BYTES=8*1024*1024;
/** Single-host private, immutable attempt ledger. Not a distributed scheduler or artifact store. */
export class FileReleasePreparationStore {
  readonly directory:string;readonly path:string;private readonly locks:FileStateStore;
  constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'preparation.json');this.locks=new FileStateStore(join(this.directory,'locks'));}
  async load():Promise<ReleasePreparationState|undefined>{
    try{const info=await stat(this.path);if(!info.isFile()||info.size>MAX_BYTES)throw Error('Release preparation exceeds local limits');
      return readReleasePreparationState(JSON.parse(await readFile(this.path,'utf8')));
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  save(state:ReleasePreparationState):Promise<void>{return this.writeJson(this.path,readReleasePreparationState(state));}
  async writeJson(path:string,value:unknown):Promise<void>{
    if(resolve(path,'..')!==this.directory)throw Error('Release evidence must remain in its bound store');
    const bytes=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('Release evidence exceeds local limits');
    await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
    try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,path);
      const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}
    }finally{await rm(temporary,{force:true});}
  }
  withLock<T>(work:()=>Promise<T>):Promise<T>{return this.locks.withLock('prepare-release',work);}
}
