import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileResourceFlowStore } from '../resource-flow/store.ts';
import { fingerprint } from '../util.ts';
import type { MasterReview } from '../master/types.ts';
import type { CheckExecutionState } from '../checks/types.ts';
import type { SystemdHostObservation } from './types.ts';
export interface SystemdReview {
  kind:'systemd-deployment-review';ok:true;reviewId:string;graphDigest:string;facts:SystemdHostObservation;factsDigest:string;
  checkContractDigest:string;applicationContract:{runnerId:string;suiteId:string;suiteDigest:string;requiredCheckIds:string[]};checks:CheckExecutionState[];masterReview:MasterReview;seal:string;
}
export interface SystemdAttempt {id:string;reviewId:string;status:'started'|'blocked'|'incomplete'|'promoted'|'verification-failed';result?:unknown}
export interface SystemdReconciliation {attemptId:string;reviewId:string;status:'reconciled-failed'|'incomplete';reconciliation:import('../execution/reconciliation.ts').EngineReconciliationResult}
export interface SystemdLedger {version:1;id:string;bindingDigest:string;currentReviewId?:string;reviews:SystemdReview[];attempts:SystemdAttempt[];reconciliations?:SystemdReconciliation[]}
export function sealReview(review:Omit<SystemdReview,'seal'>|SystemdReview):string {
  return fingerprint({reviewId:review.reviewId,graphDigest:review.graphDigest,factsDigest:review.factsDigest,checkContractDigest:review.checkContractDigest,applicationContract:review.applicationContract,
    masterReviewId:review.masterReview.reviewId,candidateDigest:review.masterReview.candidateDigest,planDigest:review.masterReview.planDigest});
}
export class SystemdDeploymentStore {
  private readonly files:FileResourceFlowStore;readonly path:string;
  readonly directory:string;private readonly id:string;private readonly bindingDigest:string;
  constructor(directory:string,id:string,bindingDigest:string){this.directory=directory;this.id=id;this.bindingDigest=bindingDigest;this.files=new FileResourceFlowStore(directory);this.path=join(directory,'systemd-deployment.json');}
  async load():Promise<SystemdLedger>{
    try{const stat=await lstat(this.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error();const value=JSON.parse(await readFile(this.path,'utf8')) as SystemdLedger;
      if(value.version!==1||value.id!==this.id||value.bindingDigest!==this.bindingDigest||!Array.isArray(value.reviews)||!Array.isArray(value.attempts)
        ||value.reconciliations!==undefined&&!Array.isArray(value.reconciliations)
        ||value.reviews.some(review=>review.seal!==sealReview(review)||review.factsDigest!==fingerprint({...review.facts,units:[...review.facts.units].sort((a,b)=>a.name.localeCompare(b.name))})))throw Error();
      return value;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{version:1,id:this.id,bindingDigest:this.bindingDigest,reviews:[],attempts:[]};throw Error('systemd-deployment-ledger-not-admitted');}
  }
  save(value:SystemdLedger){return this.files.writeJson(this.path,value);}
  withLock<T>(work:()=>Promise<T>){return this.files.withLock(work);}
}
