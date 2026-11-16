import {lstat,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {FileResourceFlowStore} from '../resource-flow/store.ts';
import type {RegistryState} from './state.ts';
/** The owner anchor distinguishes a new registry from a missing ledger; neither file is silently reset. */
export class OnboardingRegistryStore {
 readonly directory:string;readonly path:string;readonly anchorPath:string;private readonly files:FileResourceFlowStore;
 constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'onboarding-versions.json');this.anchorPath=join(this.directory,'owner.json');this.files=new FileResourceFlowStore(this.directory);}
 private async read(path:string){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Bound onboarding registry');return JSON.parse(await readFile(path,'utf8')) as unknown;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw Error('Onboarding registry could not be admitted');}}
 async load(){const [state,anchor]=await Promise.all([this.read(this.path),this.read(this.anchorPath)]);if((state===undefined)!==(anchor===undefined))throw Error('Onboarding registry owner or ledger is missing; inspect retained state');return state===undefined?undefined:{state,anchor};}
 async initialize(state:RegistryState){if(await this.load())throw Error('Onboarding registry already exists');await this.files.writeJson(this.anchorPath,{version:1,id:state.id,bindingDigest:state.bindingDigest,owner:state.owner});await this.save(state);}
 save(state:RegistryState){return this.files.writeJson(this.path,state);}
 write(path:string,value:unknown){if(resolve(path,'..')!==this.directory)throw Error('Registry evidence left its owner directory');return this.files.writeJson(path,value);}
 withLock<T>(work:()=>Promise<T>){return this.files.withLock(work);}
}
