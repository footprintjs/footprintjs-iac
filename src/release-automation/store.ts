import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,rm,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {FileStateStore} from '../store.ts';
import {identifier} from '../graph/data.ts';
import {readReleaseAutomationState} from './data.ts';
import type {ReleaseAutomationState} from './types.ts';

/** Single-host process lock and atomic private ledger; shared hosts need a transactional store. */
export class FileReleaseAutomationStore {
  readonly directory:string;readonly path:string;private readonly locks:FileStateStore;
  constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'release-automation.json');this.locks=new FileStateStore(join(this.directory,'locks'));}
  async load():Promise<ReleaseAutomationState|undefined>{try{const info=await stat(this.path);if(!info.isFile()||info.size>32*1024*1024)throw Error('Bound release automation ledger');return readReleaseAutomationState(JSON.parse(await readFile(this.path,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
  save(state:ReleaseAutomationState):Promise<void>{return this.writeJson(this.path,readReleaseAutomationState(state));}
  async writeJson(path:string,value:unknown){
    if(dirname(resolve(path))!==this.directory)throw Error('Automation evidence left its store');const bytes=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(bytes)>32*1024*1024)throw Error('Bound release automation evidence');
    await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
    try{try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,path);const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}}finally{await rm(temporary,{force:true});}
  }
  withLock<T>(work:()=>Promise<T>):Promise<T>{return this.locks.withLock('release-automation',work);}
  attemptDirectory(id:string){return join(this.directory,'attempts',identifier(id,'automation attempt'));}
}
