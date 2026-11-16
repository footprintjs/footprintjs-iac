import {createHash} from 'node:crypto';
import {isAbsolute,normalize} from 'node:path';
import {identifier} from '../graph/data.ts';
import {runHostProcess} from '../platform-access/process.ts';
import {FILE_RELEASE_PROGRAM} from './target-program.ts';
import {packageFailure,readDirectoryPackageManifest,readPackageTarget,readPackageReceipt} from './data.ts';
import {isPackageSettlementProof} from './recording.ts';
import type {FileReleaseTargetOptions,PackageReleaseTarget} from './types.ts';

/** A fixed filesystem operator over the same local/SSH/management runner port as systemd. */
export function createFileReleaseTarget(options:FileReleaseTargetOptions):PackageReleaseTarget{
 const id=identifier(options.id,'package target'),directory=options.directory;
 if(typeof directory!=='string'||!isAbsolute(directory)||normalize(directory)!==directory||directory==='/'||directory.length>4096||/[\x00-\x1f\x7f]/.test(directory))packageFailure();
 const runner=options.runner??runHostProcess,sudo=options.sudo??false,allowRuntimeTraversal=options.allowRuntimeTraversal??false;if(typeof runner!=='function'||typeof sudo!=='boolean'||typeof allowRuntimeTraversal!=='boolean')packageFailure();
 const call=async(operation:string,payload:Record<string,unknown>={})=>{
  try{const input=JSON.stringify({id,directory,operation,allowRuntimeTraversal,...payload});if(Buffer.byteLength(input)>190000000)packageFailure();const result=await runner({file:sudo?'sudo':'python3',args:sudo?['-n','python3','-c',FILE_RELEASE_PROGRAM]:['-c',FILE_RELEASE_PROGRAM],input,timeoutMs:180000,maxOutputBytes:256*1024});if(result.code!==0||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>256*1024)packageFailure();return JSON.parse(result.stdout);}catch{return packageFailure();}
 };
 const target:PackageReleaseTarget={id,
  async inspect(){const observed=readPackageTarget(await call('inspect'));if(observed.id!==id)packageFailure();return observed;},
  async stage(source,before,context){
   const manifest=readDirectoryPackageManifest(source.manifest),files=[];if(context.targetId!==id||context.packageDigest!==manifest.digest)packageFailure();readPackageTarget(before);
   for(const f of manifest.files){const bytes=await source.read(f.path);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==f.bytes||createHash('sha256').update(bytes).digest('hex')!==f.digest)packageFailure();files.push({path:f.path,content:Buffer.from(bytes).toString('base64')});}
   return readPackageTarget(await call('stage',{manifest,files,before,context}));
  },
  async activate(before,context){readPackageTarget(before);return readPackageReceipt(await call('activate',{before,context}));},
  async settle(receipt,proof,context){readPackageReceipt(receipt);if(!isPackageSettlementProof(proof))packageFailure();const result=await call('settle',{receipt,proof,context});if(result.ok!==true||Object.keys(result).length!==1)packageFailure();},
 };return Object.freeze(target);
}
