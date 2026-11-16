import {createHash} from 'node:crypto';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {identifier} from '../graph/data.ts';
import {fingerprint} from '../util.ts';
import {packageFailure,packagePath,readDirectoryPackageManifest} from './data.ts';
import type {DirectoryPackageSource} from './types.ts';

function directoryReader(directory:string,paths:readonly string[]){
 if(!isAbsolute(directory)||resolve(directory)!==directory||directory==='/')packageFailure();
 return async(path:string)=>{
  if(!paths.includes(packagePath(path))||await realpath(directory)!==directory)packageFailure();let current=directory;
  for(const part of path.split('/')){current=join(current,part);const info=await lstat(current);if(info.isSymbolicLink()||current!==join(directory,path)&&!info.isDirectory())packageFailure();}
  const info=await lstat(current);if(!info.isFile()||info.nlink!==1||info.size>128*1024*1024)packageFailure();const handle=await open(current,'r');
  try{const opened=await handle.stat();if(opened.ino!==info.ino||opened.dev!==info.dev||opened.size!==info.size)packageFailure();return new Uint8Array(await handle.readFile());}finally{await handle.close();}
 };
}
/** Provider-free source reconstruction. Filesystem checks happen only when the private read port is invoked. */
export function createDirectoryPackageSource(options:{directory:string;manifest:DirectoryPackageSource['manifest']}):DirectoryPackageSource{
 const manifest=readDirectoryPackageManifest(options.manifest),directory=options.directory,read=directoryReader(directory,manifest.files.map(file=>file.path));
 return Object.freeze({manifest,async read(path:string){const file=manifest.files.find(file=>file.path===path);if(!file)packageFailure();const bytes=await read(path);const info=await lstat(join(directory,path));
  if(bytes.byteLength!==file!.bytes||createHash('sha256').update(bytes).digest('hex')!==file!.digest||(info.mode&0o111?493:420)!==file!.mode)packageFailure();return bytes;
 }});
}
/** Explicit build adapter helper. Uses only registered regular files; no extraction or code execution. */
export async function buildDirectoryPackage(options:{id:string;directory:string;paths:readonly string[]}):Promise<DirectoryPackageSource>{
 const id=identifier(options.id,'package'),directory=resolve(options.directory);if(!isAbsolute(options.directory)||await realpath(directory)!==directory||!Array.isArray(options.paths)||!options.paths.length||options.paths.length>4096)packageFailure();
 const paths=options.paths.map(packagePath).sort();if(new Set(paths).size!==paths.length)packageFailure();const read=directoryReader(directory,paths);
 const files=[];let total=0;for(const path of paths){const bytes=await read(path);total+=bytes.byteLength;if(total>128*1024*1024)packageFailure();const info=await lstat(join(directory,path));files.push({path,digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength,mode:(info.mode&0o111?493:420) as 420|493});}
 const body={version:1 as const,kind:'directory-package' as const,id,files};const manifest=readDirectoryPackageManifest({...body,digest:fingerprint(body)});
 return createDirectoryPackageSource({directory,manifest});
}
