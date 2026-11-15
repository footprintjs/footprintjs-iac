import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,rm,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {FileStateStore} from '../store.ts';
import {readChangeAssessmentState} from './state.ts';
import type {ChangeAssessmentState} from './types.ts';
const MAX=8*1024*1024;
export class FileChangeAssessmentStore{
  readonly directory:string;readonly path:string;private readonly locks:FileStateStore;
  constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'assessment.json');this.locks=new FileStateStore(join(this.directory,'locks'));}
  async load():Promise<ChangeAssessmentState|undefined>{try{const info=await stat(this.path);if(!info.isFile()||info.size>MAX)throw Error('Assessment ledger exceeds local limits');
    return readChangeAssessmentState(JSON.parse(await readFile(this.path,'utf8')));
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
  save(state:ChangeAssessmentState):Promise<void>{return this.writeJson(this.path,readChangeAssessmentState(state));}
  async writeJson(path:string,value:unknown):Promise<void>{
    if(dirname(resolve(path))!==this.directory)throw Error('Assessment evidence left its store');const bytes=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(bytes)>MAX)throw Error('Assessment evidence exceeds local limits');
    await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
    try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,path);const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}}
    finally{await rm(temporary,{force:true});}
  }
  withLock<T>(work:()=>Promise<T>):Promise<T>{return this.locks.withLock('assessment',work);}
}
