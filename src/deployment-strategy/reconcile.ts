import type { ApplyResult, InfraEngine } from '../engine.ts';
import type { InfraGraph } from '../graph/types.ts';
import type { MasterWorkflow } from '../master/workflow.ts';
import { verifyRevisionOutcome } from '../master/evidence.ts';
import { fingerprintPlan } from '../master/plan.ts';
import { verifySystemdReplay } from './replay.ts';
import type { SystemdResourceAdapter } from './systemd-resource.ts';
import type { SystemdDeploymentStore } from './store.ts';

/** Close only an admitted failed native effect. Original attempts and applied head are immutable. */
export function createSystemdReconciler(input:{store:SystemdDeploymentStore;master:MasterWorkflow;engine:InfraEngine;adapter:SystemdResourceAdapter;graph:InfraGraph}){
  return (reviewId:string)=>input.store.withLock(async()=>{
    const state=await input.store.load(),history=await input.master.getState();
    await verifySystemdReplay(state,history);
    const attempt=state.attempts.find(row=>row.reviewId===reviewId),review=state.reviews.find(row=>row.reviewId===reviewId);
    if(!attempt||!review||attempt.status!=='incomplete')throw Error('systemd-incomplete-native-attempt-required');
    const previous=state.reconciliations?.find(row=>row.attemptId===attempt.id&&row.status==='reconciled-failed');
    if(previous)return{ok:false as const,promoted:false as const,status:previous.status,reviewId,reconciliation:structuredClone(previous.reconciliation)};
    const result=attempt.result as {deployment?:ApplyResult}|undefined,deployment=result?.deployment;
    const native=history.attempts.find(row=>row.reviewId===review.masterReview.reviewId&&row.revisionDigest===review.masterReview.candidateDigest);
    const revision=history.revisions.find(row=>row.digest===review.masterReview.candidateDigest);
    if(!deployment||deployment.ok||!native||native.status!=='failed'||!revision||revision.graph.digest!==input.graph.digest
      ||native.runId!==deployment.runId||native.evidencePath!==deployment.evidencePath||native.tracePath!==deployment.tracePath
      ||native.planDigest!==review.masterReview.planDigest||fingerprintPlan(deployment.plan)!==review.masterReview.planDigest)throw Error('systemd-complete-failed-native-outcome-required');
    await verifyRevisionOutcome(revision,deployment);
    input.adapter.prepareOutcome(review.facts);
    const reconciliation=await input.engine.reconcile(revision.graph,deployment),status=reconciliation.status==='failed'?'reconciled-failed' as const:'incomplete' as const;
    (state.reconciliations??=[]).push({attemptId:attempt.id,reviewId,status,reconciliation});
    await verifySystemdReplay(state,history);await input.store.save(state);
    return{ok:false as const,promoted:false as const,status,reviewId,reconciliation:structuredClone(reconciliation)};
  });
}
