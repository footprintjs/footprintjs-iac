import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {FileResourceFlowStore} from '../resource-flow/store.ts';
import type {OnboardingState} from './state.ts';
export class OnboardingStore {
 readonly directory:string;readonly path:string;private readonly files:FileResourceFlowStore;
 constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'onboarding.json');this.files=new FileResourceFlowStore(this.directory);}
 async load():Promise<unknown>{try{const info=await lstat(this.path);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Invalid onboarding ledger');return JSON.parse(await readFile(this.path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
 save(state:OnboardingState){return this.files.writeJson(this.path,state);}
 write(path:string,value:unknown){if(resolve(path,'..')!==this.directory)throw Error('Onboarding evidence left its directory');return this.files.writeJson(path,value);}
 withLock<T>(work:()=>Promise<T>){return this.files.withLock(work);}
}
