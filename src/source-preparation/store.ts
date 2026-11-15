import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {FileDeliveryStore} from '../delivery/store.ts';
import {readSourcePreparationState} from './data.ts';
import type {SourcePreparationState} from './types.ts';

/** One immutable preparation per directory; uses the same synced private writes and locking as delivery. */
export class FileSourcePreparationStore {
 readonly directory:string;readonly path:string;private readonly writer:FileDeliveryStore;
 constructor(directory:string){this.directory=resolve(directory);this.path=join(this.directory,'source-preparation.json');this.writer=new FileDeliveryStore(this.directory);}
 async load():Promise<SourcePreparationState|undefined>{try{const info=await lstat(this.path);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw Error('Source preparation ledger exceeds local limits');return readSourcePreparationState(JSON.parse(await readFile(this.path,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
 save(state:SourcePreparationState):Promise<void>{return this.writer.writeJson(this.path,readSourcePreparationState(state));}
 writeJson(path:string,value:unknown):Promise<void>{return this.writer.writeJson(path,value);}
 withLock<T>(work:()=>Promise<T>):Promise<T>{return this.writer.withLock(work);}
}
