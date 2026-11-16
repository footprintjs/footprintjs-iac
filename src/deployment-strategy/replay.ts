import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { verifyRevisionOutcome } from '../master/evidence.ts';
import { loadCheckRecording } from '../checks/recording.ts';
import { readCheckResult } from '../checks/data.ts';
import { fingerprintPlan } from '../master/plan.ts';
import { canonical } from '../util.ts';
import type { ApplyResult } from '../engine.ts';
import type { CheckExecutionState } from '../checks/types.ts';
import type { MasterState } from '../master/types.ts';
import type { SystemdLedger } from './store.ts';
import {admitEngineReconciliation} from '../execution/reconciliation.ts';
import {admitSystemdOutcomeProof} from './outcome-proof.ts';

/** Reopening proves retained outcomes against native records; no host/check port is invoked. */
export async function verifySystemdReplay(state:SystemdLedger, master:MasterState):Promise<void> {
  for(const row of state.reconciliations??[]){
    const attempt=state.attempts.find(attempt=>attempt.id===row.attemptId&&attempt.reviewId===row.reviewId);
    const review=state.reviews.find(review=>review.reviewId===row.reviewId),result=attempt?.result as {deployment?:ApplyResult}|undefined;
    const native=master.attempts.find(native=>native.reviewId===review?.masterReview.reviewId&&native.runId===result?.deployment?.runId);
    const revision=master.revisions.find(revision=>revision.digest===review?.masterReview.candidateDigest);
    if(!attempt||attempt.status!=='incomplete'||!review||!result?.deployment||result.deployment.ok||!native||native.status!=='failed'
      ||!revision||native.revisionDigest!==revision.digest||native.evidencePath!==result.deployment.evidencePath||native.tracePath!==result.deployment.tracePath
      ||native.planDigest!==review.masterReview.planDigest||fingerprintPlan(result.deployment.plan)!==review.masterReview.planDigest
      ||row.status!==(row.reconciliation.status==='failed'?'reconciled-failed':'incomplete'))throw Error('systemd-reconciliation-binding-not-admitted');
    await verifyRevisionOutcome(revision,result.deployment);
    await admitEngineReconciliation(row.reconciliation,result.deployment);
    if(row.status==='reconciled-failed'){
      const evidence=await loadEvidence(row.reconciliation.evidencePath),ids=evidence.snapshot.sharedState.operationIds as string[];
      for(const id of ids){
        const operation=result.deployment.plan.operations.find(operation=>operation.operationId===id)!;
        const inspection=evidence.snapshot.sharedState[`inspection:${operation.resource.id}`] as {evidence?:{proof?:import('./types.ts').SystemdOutcomeInspection['proof']}};
        if(!inspection?.evidence?.proof)throw Error('systemd-reconciliation-proof-missing');
        await admitSystemdOutcomeProof(inspection.evidence.proof,id);
      }
    }
  }
  for(const attempt of state.attempts){
    if(!['promoted','verification-failed'].includes(attempt.status))continue;
    const review=state.reviews.find(row=>row.reviewId===attempt.reviewId), revision=master.revisions.find(row=>row.digest===review?.masterReview.candidateDigest);
    const result=attempt.result as {status?:string;ok?:boolean;promoted?:boolean;deployment?:ApplyResult;applicationChecks?:CheckExecutionState}|undefined;
    if(!review||!revision||!result?.deployment?.ok||!result.applicationChecks||result.status!==attempt.status
      ||result.ok!==(attempt.status==='promoted')||result.promoted!==(attempt.status==='promoted'))throw Error('systemd-native-outcome-not-admitted');
    const nativeAttempt=master.attempts.find(row=>row.reviewId===review.masterReview.reviewId&&row.revisionDigest===revision.digest&&row.status==='applied');
    if(!nativeAttempt||nativeAttempt.runId!==result.deployment.runId||nativeAttempt.evidencePath!==result.deployment.evidencePath
      ||nativeAttempt.tracePath!==result.deployment.tracePath||nativeAttempt.planDigest!==review.masterReview.planDigest
      ||fingerprintPlan(result.deployment.plan)!==review.masterReview.planDigest)throw Error('systemd-native-master-outcome-differs');
    await verifyRevisionOutcome(revision,result.deployment);
    await verifyEvidenceTrace(await loadEvidence(result.deployment.evidencePath));
    const checked=result.applicationChecks, measured=readCheckResult(checked.result);
    if(!checked.recording?.complete||checked.request.releaseDigest!==revision.graph.digest||measured.request.releaseDigest!==revision.graph.digest
      ||canonical(checked.request.target)!==canonical(revision.target)||checked.request.releaseId!==revision.graph.name
      ||!['application','application-contract'].includes(checked.request.stageId)
      ||attempt.status==='promoted'&&(checked.status!=='passed'||measured.status!=='passed'))throw Error('systemd-native-application-not-admitted');
    if(checked.runnerId==='approved-check-contract'){
      if(attempt.status!=='verification-failed'||checked.request.suiteId!=='approved-check-contract'||measured.status==='passed')throw Error('systemd-native-contract-outcome-invalid');
    }else{
      const contract=review.applicationContract;
      const ids=measured.checks.map(check=>check.id),ordinary=contract&&canonical(ids)===canonical(contract.requiredCheckIds);
      const gated=contract&&attempt.status==='verification-failed'&&canonical(ids)===canonical([...contract.requiredCheckIds,'required-checks'])&&measured.checks.at(-1)?.status==='failed';
      if(!contract||checked.runnerId!==contract.runnerId||checked.request.suiteId!==contract.suiteId||checked.request.suiteDigest!==contract.suiteDigest
        ||!ordinary&&!gated)throw Error('systemd-native-application-suite-differs');
    }
    const capture=await loadCheckRecording(checked.recording.evidencePath,{runId:checked.recording.runId,bindingDigest:checked.bindingDigest});
    const native=capture.snapshot as {sharedState?:Record<string,unknown>};
    if(canonical(native.sharedState?.request)!==canonical(checked.request)||canonical(native.sharedState?.result)!==canonical(measured))throw Error('systemd-native-application-outcome-differs');
    await verifyEvidenceTrace(await loadEvidence(checked.recording.evidencePath));
  }
}
