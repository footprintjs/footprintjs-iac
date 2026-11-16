import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {FileResourceFlowStore} from '../resource-flow/store.ts';
import {readPackageActivationState} from './data.ts';
import type {PackageActivationState} from './types.ts';
export class PackageActivationStore {
 readonly directory:string;readonly path:string;private readonly files:FileResourceFlowStore;
 constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'package-activation.json');this.files=new FileResourceFlowStore(this.directory);}
 async load():Promise<PackageActivationState|undefined>{try{const info=await lstat(this.path);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error();return readPackageActivationState(JSON.parse(await readFile(this.path,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw Error('package-activation-ledger-not-admitted');}}
 save(state:PackageActivationState){return this.files.writeJson(this.path,readPackageActivationState(state));}
 write(path:string,value:unknown){return this.files.writeJson(path,value);}
 withLock<T>(work:()=>Promise<T>){return this.files.withLock(work);}
}
