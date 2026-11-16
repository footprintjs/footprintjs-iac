import {freeze,identifier,jsonCopy} from '../graph/data.ts';
import {fingerprint} from '../util.ts';
import type {DirectoryPackageManifest,PackageTargetObservation,PackageRuntimeObservation,PackageActivationReceipt,PackageActivationState,PackageNativeRecording} from './types.ts';

export const packageFailure=():never=>{throw Error('package-runtime-not-admitted');};
export function hash(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))packageFailure();return value as string;}
export function packagePath(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)
  ||value==='.package.json'||value.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git'||part==='.env'||part.startsWith('.env.')))packageFailure();
 return value as string;
}
function row(value:unknown,keys:string[]):Record<string,any>{const result=jsonCopy(value);if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(k=>!keys.includes(k)))packageFailure();return result as Record<string,any>;}
const nullableHash=(value:unknown)=>value===null?null:hash(value);
export function readDirectoryPackageManifest(input:unknown):DirectoryPackageManifest{
 const value=row(input,['version','kind','id','files','digest']);if(value.version!==1||value.kind!=='directory-package')packageFailure();identifier(value.id,'package');
 if(!Array.isArray(value.files)||!value.files.length||value.files.length>4096)packageFailure();
 let bytes=0;const files=value.files.map((input:unknown)=>{const f=row(input,['path','digest','bytes','mode']);packagePath(f.path);hash(f.digest);if(!Number.isSafeInteger(f.bytes)||f.bytes<0||![420,493].includes(f.mode))packageFailure();bytes+=f.bytes;return f;});
 if(bytes>128*1024*1024||new Set(files.map((f:any)=>f.path)).size!==files.length||files.some((f:any,i:number)=>i>0&&files[i-1]!.path>=f.path))packageFailure();
 const names=new Set(files.map((f:any)=>f.path));for(const f of files){let prefix='';for(const part of f.path.split('/').slice(0,-1)){prefix=prefix?prefix+'/'+part:part;if(names.has(prefix))packageFailure();}}
 const {digest,...body}=value;if(hash(digest)!==fingerprint(body))packageFailure();return freeze(value as unknown as DirectoryPackageManifest);
}
export function readPackageTarget(input:unknown):PackageTargetObservation{
 const v=row(input,['id','exists','identityDigest','currentDigest','previousDigest','pendingOperationId']);identifier(v.id,'package target');if(typeof v.exists!=='boolean')packageFailure();nullableHash(v.identityDigest);nullableHash(v.currentDigest);nullableHash(v.previousDigest);if(v.pendingOperationId!==null)identifier(v.pendingOperationId,'package operation');
 if(v.exists!==!!v.identityDigest||!v.exists&&(v.currentDigest||v.previousDigest||v.pendingOperationId))packageFailure();return freeze(v as unknown as PackageTargetObservation);
}
export function readPackageReceipt(input:unknown):PackageActivationReceipt{const v=row(input,['operationId','packageDigest','previousDigest','identityDigest']);identifier(v.operationId,'package operation');hash(v.packageDigest);hash(v.identityDigest);nullableHash(v.previousDigest);return freeze(v as unknown as PackageActivationReceipt);}
export function readPackageRuntimeObservation(input:unknown):PackageRuntimeObservation{
 const v=row(input,['runtimeId','packageDigest','ready','evidence']);if(typeof v.runtimeId!=='string'||!v.runtimeId||v.runtimeId.length>512||/[\x00-\x1f\x7f]/.test(v.runtimeId)||typeof v.ready!=='boolean')packageFailure();nullableHash(v.packageDigest);
 const evidence=row(v.evidence,['method','digest','complete']);if(!['process-files','immutable-image'].includes(evidence.method)||typeof evidence.complete!=='boolean')packageFailure();hash(evidence.digest);return freeze(v as unknown as PackageRuntimeObservation);
}
export function readPackageActivationState(input:unknown):PackageActivationState{
 const v=row(input,['version','kind','definition','definitionDigest','operationId','status','stages','events','before','staged','receipt','observation','recording','reconciliationBase','reconciliationIntent','reconciliations','error']);
 if(v.version!==1||v.kind!=='package-activation-state')packageFailure();const d=row(v.definition,['id','targetId','packageId','packageDigest','configurationDigest']);for(const name of ['id','targetId','packageId'])identifier(d[name],name);hash(d.packageDigest);hash(d.configurationDigest);if(v.definitionDigest!==fingerprint(d))packageFailure();
 if(v.operationId!==null)identifier(v.operationId,'package operation');if(!['idle','running','ready','verification-failed','failed','incomplete'].includes(v.status))packageFailure();
 const ids=['verify','stage','activate','observe'];if(!Array.isArray(v.stages)||v.stages.length!==4||!Array.isArray(v.events)||v.events.length>8)packageFailure();
 const projected=new Map(ids.map(id=>[id,'pending']));let last=0;
 for(const [index,input] of v.events.entries()){const e=row(input,['sequence','stageId','status','runtimeStageId','timestamp']);const at=ids.indexOf(e.stageId);if(e.sequence!==index+1||at<0||at<last||!Number.isFinite(e.timestamp)||typeof e.runtimeStageId!=='string'||!e.runtimeStageId)packageFailure();if(ids.slice(0,at).some(id=>projected.get(id)!=='passed'))packageFailure();const old=projected.get(e.stageId);if(old==='pending'?e.status!=='running':old!=='running'||!['passed','failed'].includes(e.status))packageFailure();projected.set(e.stageId,e.status);last=at;}
 v.stages.forEach((input:unknown,index:number)=>{const s=row(input,['id','label','status']);if(s.id!==ids[index]||typeof s.label!=='string'||s.label.length>160||s.status!==projected.get(s.id))packageFailure();});
 if(v.before!==undefined)readPackageTarget(v.before);if(v.staged!==undefined)readPackageTarget(v.staged);if(v.receipt!==undefined){const receipt=readPackageReceipt(v.receipt);if(receipt.operationId!==v.operationId||receipt.packageDigest!==d.packageDigest)packageFailure();}if(v.observation!==undefined)readPackageRuntimeObservation(v.observation);
 if(v.recording!==undefined)readPackageNativeRecording(v.recording);
 if(v.reconciliationBase!==undefined){const base=row(v.reconciliationBase,['status','observation']);if(base.status!==undefined&&!['incomplete','verification-failed'].includes(base.status))packageFailure();if(base.observation!==undefined)readPackageRuntimeObservation(base.observation);}
 if(v.reconciliationIntent!==undefined){const intent=row(v.reconciliationIntent,['id','phase']);identifier(intent.id,'package reconciliation');if(!['observe','settle'].includes(intent.phase)||v.status!=='incomplete')packageFailure();}
 if(v.reconciliations!==undefined){if(!Array.isArray(v.reconciliations)||v.reconciliations.length>32||!v.reconciliationBase)packageFailure();const ids=new Set();for(const input of v.reconciliations){const r=row(input,['id','configurationDigest','originalRunId','originalRecordingDigest','previousRecordingDigest','status','target','observation','observationRecording','settlementRecording','recording']);identifier(r.id,'package reconciliation');hash(r.configurationDigest);if(ids.has(r.id))packageFailure();ids.add(r.id);if(typeof r.originalRunId!=='string'||!r.originalRunId||r.originalRunId.length>512)packageFailure();hash(r.originalRecordingDigest);nullableHash(r.previousRecordingDigest);if(!['ready','verification-failed','incomplete'].includes(r.status))packageFailure();if(r.target!==undefined)readPackageTarget(r.target);if(r.observation!==undefined)readPackageRuntimeObservation(r.observation);readPackageNativeRecording(r.observationRecording);if(r.settlementRecording!==undefined)readPackageNativeRecording(r.settlementRecording);readPackageNativeRecording(r.recording);if(['ready','verification-failed'].includes(r.status)&&(!r.observation?.evidence.complete||!r.settlementRecording?.complete))packageFailure();}}
 if(v.reconciliationBase!==undefined&&!v.reconciliationIntent&&!v.reconciliations?.length)packageFailure();
 const completed=v.stages.every((s:any)=>s.status==='passed')||v.reconciliations?.length&&v.stages.slice(0,3).every((s:any)=>s.status==='passed');if(['ready','verification-failed'].includes(v.status)&&(!completed||!v.receipt||!v.observation||!v.recording?.complete))packageFailure();
 if(v.status==='ready'&&(!v.observation.ready||!v.observation.evidence.complete||v.observation.packageDigest!==d.packageDigest))packageFailure();
 if(v.status==='verification-failed'&&(!v.observation.evidence.complete||v.observation.ready&&v.observation.packageDigest===d.packageDigest))packageFailure();
 if(v.status==='failed'&&(!v.stages.some((s:any)=>s.status==='failed')||v.receipt||!v.recording?.complete))packageFailure();
 if(v.reconciliations?.length&&['ready','verification-failed'].includes(v.status)&&v.reconciliations.at(-1).status!==v.status)packageFailure();
 if(v.status==='idle'&&(v.operationId!==null||v.events.length||v.before||v.staged||v.receipt||v.observation||v.recording))packageFailure();if(v.status!=='idle'&&v.operationId===null)packageFailure();
 if(v.error!==undefined&&(typeof v.error!=='string'||v.error.length>4096))packageFailure();return freeze(v as unknown as PackageActivationState);
}
export function readPackageNativeRecording(input:unknown):PackageNativeRecording{const r=row(input,['runId','evidencePath','tracePath','digest','complete']);for(const k of ['runId','evidencePath','tracePath'])if(typeof r[k]!=='string'||!r[k]||r[k].length>4096)packageFailure();hash(r.digest);if(typeof r.complete!=='boolean')packageFailure();return freeze(r as unknown as PackageNativeRecording);}
export function packageActivationProof(input:PackageActivationState):PackageNativeRecording|undefined{const state=readPackageActivationState(input);return state.reconciliations?.at(-1)?.recording??state.recording;}
