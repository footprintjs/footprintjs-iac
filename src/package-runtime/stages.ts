import {createHash} from 'node:crypto';
import {canonical} from '../util.ts';
import {readPackageRuntimeObservation,readPackageTarget,readPackageReceipt} from './data.ts';
import type {PackageScope} from './scope.ts';
import type {DirectoryPackageSource,PackageActivationState,PackageOperationContext,PackageReleaseTarget,PackageRuntimePort,PackageStageId} from './types.ts';
export const PACKAGE_RUNTIME_EVENT='iac:package-runtime-progress';
export interface PackageStageConfiguration {
 state:PackageActivationState;source:DirectoryPackageSource;target:PackageReleaseTarget;runtime:PackageRuntimePort;
 persist():Promise<void>;activationStarted():void;
}
const context=(c:PackageStageConfiguration):PackageOperationContext=>({operationId:c.state.operationId!,packageDigest:c.source.manifest.digest,targetId:c.target.id});
function stage(c:PackageStageConfiguration,id:PackageStageId,inputs:string[],work:(scope:PackageScope)=>Promise<void>){return async(scope:PackageScope)=>{
 if(id==='verify'){scope.setValue('definition',c.state.definition);scope.setValue('operationId',c.state.operationId);}
 const progress=async(status:'running'|'passed'|'failed')=>{const event={stageId:id,status};scope.setValue('progress:'+id,event);scope.emitEvent(PACKAGE_RUNTIME_EVENT,event);await c.persist();};
 await progress('running');try{
  if(canonical(scope.getValue('definition'))!==canonical(c.state.definition)||scope.getValue('operationId')!==c.state.operationId)throw Error('binding changed');
  for(const name of inputs)if(canonical(scope.getValue(name))!==canonical(c.state[name as keyof PackageActivationState]))throw Error('recorded input changed');
  await work(scope);await progress('passed');
 }catch{scope.setValue('failure',{stageId:id,code:id==='activate'?'package-effect-unconfirmed':'package-stage-not-confirmed'});await progress('failed');throw Error('The registered package stage did not confirm its outcome.');}
};}
export const verifyPackageStage=(c:PackageStageConfiguration)=>stage(c,'verify',[],async scope=>{
 for(const file of c.source.manifest.files){
  let bytes:Uint8Array;try{bytes=await c.source.read(file.path);}catch{scope.setValue('packageVerification',{ok:false,file:file.path,code:'source-file-unavailable'});scope.getValue('packageVerification');throw Error('package unavailable');}
  const actual=bytes instanceof Uint8Array?createHash('sha256').update(bytes).digest('hex'):null;
  if(!(bytes instanceof Uint8Array)||bytes.byteLength!==file.bytes||actual!==file.digest){scope.setValue('packageVerification',{ok:false,file:file.path,code:'source-file-changed',expectedDigest:file.digest,actualDigest:actual});scope.getValue('packageVerification');throw Error('package changed');}
 }
 scope.setValue('packageVerification',{ok:true,packageDigest:c.source.manifest.digest,fileCount:c.source.manifest.files.length});scope.getValue('packageVerification');
 const before=readPackageTarget(await c.target.inspect());if(before.id!==c.target.id||before.pendingOperationId)throw Error('target outcome pending');c.state.before=before;scope.setValue('before',before);
});
export const stagePackageStage=(c:PackageStageConfiguration)=>stage(c,'stage',['before'],async scope=>{
 const staged=readPackageTarget(await c.target.stage(c.source,c.state.before!,context(c)));
 if(!staged.exists||staged.id!==c.target.id||staged.pendingOperationId||c.state.before!.exists&&(staged.identityDigest!==c.state.before!.identityDigest||staged.currentDigest!==c.state.before!.currentDigest))throw Error('staging target changed');
 c.state.staged=staged;scope.setValue('staged',staged);
});
export const activatePackageStage=(c:PackageStageConfiguration)=>stage(c,'activate',['staged'],async scope=>{
 c.activationStarted();const receipt=readPackageReceipt(await c.target.activate(c.state.staged!,context(c)));
 if(receipt.operationId!==c.state.operationId||receipt.packageDigest!==c.source.manifest.digest||receipt.identityDigest!==c.state.staged!.identityDigest||receipt.previousDigest!==c.state.staged!.currentDigest)throw Error('activation receipt changed');
 c.state.receipt=receipt;scope.setValue('receipt',receipt);await c.persist();await c.runtime.activate(context(c));scope.setValue('runtimeActivated',true);
});
export const observePackageStage=(c:PackageStageConfiguration)=>stage(c,'observe',['receipt'],async scope=>{
 if(scope.getValue('runtimeActivated')!==true)throw Error('runtime activation missing');const observed=readPackageRuntimeObservation(await c.runtime.observe(context(c)));c.state.observation=observed;scope.setValue('observation',observed);
 const measured=readPackageRuntimeObservation(scope.getValue('observation')),expected=(scope.getValue('definition') as {packageDigest:string}).packageDigest;
 scope.setValue('runtimeVerification',{ready:measured.ready,evidenceComplete:measured.evidence.complete,codeMatches:measured.packageDigest===expected,expectedPackageDigest:expected,actualPackageDigest:measured.packageDigest,runtimeId:measured.runtimeId});
 const checked=scope.getValue('runtimeVerification') as {ready:boolean;evidenceComplete:boolean;codeMatches:boolean};
 scope.setValue('outcome',!checked.evidenceComplete?'incomplete':checked.ready&&checked.codeMatches?'ready':'verification-failed');
});
