import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { InfraEngine } from '../engine.ts';
import { FileStateStore } from '../store.ts';
import { MasterWorkflow } from '../master/workflow.ts';
import { FileMasterStore } from '../master/store.ts';
import { defineSystemRevision } from '../master/revision.ts';
import { fingerprintPlan } from '../master/plan.ts';
import { identifier } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { applicationContract, captureCheckBinding, checkContract, contractCheck, runDeploymentChecks } from './checks.ts';
import { compileSystemdDeployment } from './compile.ts';
import { factsDigest, readSystemdUnits, sha } from './data.ts';
import { SystemdResourceAdapter } from './systemd-resource.ts';
import { SystemdDeploymentStore, sealReview, type SystemdReview } from './store.ts';
import { verifySystemdReplay } from './replay.ts';
import { recordSystemdTarget } from './target-check.ts';
import {captureSystemdSourceProvenance,systemdSourceProvenanceDigest} from './source-provenance.ts';
import type { DeploymentStrategyAdapter, SystemdDeploymentOptions } from './types.ts';

/** Same engine/Master/check lifecycle as a guarded Kubernetes controller, over installed services. */
export function createSystemdDeploymentAdapter(options:SystemdDeploymentOptions):DeploymentStrategyAdapter {
  const id=identifier(options.id,'deployment adapter'), units=readSystemdUnits(options.units), graph=compileSystemdDeployment({...options,units});
  const mode=options.transaction??'group';const directory=options.stateDirectory;
  if(!isAbsolute(directory)||typeof options.host?.inspect!=='function'||(mode==='group'?typeof options.host?.applyUnits!=='function':typeof options.host?.applyUnit!=='function'))throw Error('systemd-private-host-registration-required');
  const registration={hostId:identifier(options.registration.hostId,'systemd host'),scope:options.registration.scope,identityDigest:sha(options.registration.identityDigest)};
  if(typeof registration.scope!=='string'||!registration.scope||registration.scope.length>4096||/[\x00-\x1f\x7f]/.test(registration.scope))throw Error('systemd-target-scope-required');
  const preflight=captureCheckBinding(options.preflightChecks),application=captureCheckBinding(options.applicationChecks);
  const adapter=new SystemdResourceAdapter(registration,units,options.host,mode), target={id:registration.hostId,scope:adapter.scope};
  const provenance=captureSystemdSourceProvenance(options,target,graph),provenanceDigest=systemdSourceProvenanceDigest(provenance);
  const engine=new InfraEngine({adapters:[adapter],store:new FileStateStore(join(directory,'resources')),traceDirectory:join(directory,'traces'),maxConcurrency:1,
    ...(options.recorders ? {recorders:options.recorders} : {}), ...(options.chartObservers ? {chartObservers:options.chartObservers} : {})});
  const master=new MasterWorkflow({engine,store:new FileMasterStore(join(directory,'master')),target});
  const bindingDigest=fingerprint({id,stack:options.stack,registration,units:units.map(({configurationDigest,...unit})=>unit),transaction:mode}),store=new SystemdDeploymentStore(directory,id,bindingDigest);
  const contract=()=>fingerprint({preflight:checkContract(preflight),application:checkContract(application)});
  const idle=(state:Awaited<ReturnType<typeof store.load>>)=>{if(state.attempts.some(attempt=>['started','incomplete'].includes(attempt.status)))throw Error('systemd-effects-unconfirmed-inspect-before-another-attempt');};
  const check=async(directory:string)=>{
    const measured=await recordSystemdTarget({adapter,bindingDigest,directory,releaseId:graph.name,releaseDigest:graph.digest,target});
    const checks=[measured.state];
    if(measured.passed){checks.push(await runDeploymentChecks(preflight,{directory,stageId:'preflight',releaseId:graph.name,releaseDigest:graph.digest,target}));}
    return{facts:measured.facts,checks,passed:measured.passed&&checks.every(state=>state.status==='passed'&&state.recording?.complete===true)};
  };
  return {id,kind:'systemd',
    async snapshot(){const state=await store.load(),history=await master.getState();try{await verifySystemdReplay(state,history);}catch{throw Error('systemd-native-replay-not-admitted');}return{state,master:history};},
    plan(input){return store.withLock(async()=>{
      const state=await store.load();idle(state);const measured=await check(join(directory,'checks',randomUUID()));
      if(!measured.passed||!measured.facts)return{kind:'systemd-deployment-review',ok:false,graphDigest:graph.digest,checks:measured.checks,reason:'preflight-not-verified'};
      const history=await master.getState();await master.stage(defineSystemRevision({revisionId:input.revisionId,parentDigest:history.appliedDigest,target,graph,...provenance}),{expectedAppliedDigest:history.appliedDigest});
      const reviewed=await master.preview();if(reviewed.plan.operations.some(operation=>!['update','verify','noop'].includes(operation.action)))throw Error('systemd-plan-action-not-admitted');
      const body={kind:'systemd-deployment-review' as const,ok:true as const,reviewId:randomUUID(),graphDigest:graph.digest,facts:measured.facts,factsDigest:factsDigest(measured.facts),checkContractDigest:contract(),applicationContract:applicationContract(application),checks:measured.checks,masterReview:reviewed};
      const review:SystemdReview={...body,seal:sealReview(body)};state.reviews.push(review);state.currentReviewId=review.reviewId;await store.save(state);return structuredClone(review);
    });},
    apply(reviewId){return store.withLock(async()=>{
      const state=await store.load();idle(state);if(state.attempts.some(attempt=>attempt.reviewId===reviewId))throw Error('systemd-review-already-consumed');
      const review=state.reviews.find(item=>item.reviewId===reviewId);
      if(!review||state.currentReviewId!==reviewId||review.graphDigest!==graph.digest||review.seal!==sealReview(review))throw Error('systemd-review-not-current');
      const history=await master.getState();if(history.review?.reviewId!==review.masterReview.reviewId||history.review.planDigest!==review.masterReview.planDigest)throw Error('systemd-master-review-not-current');
      const candidate=history.revisions.find(revision=>revision.digest===review.masterReview.candidateDigest);
      if(!candidate||systemdSourceProvenanceDigest(candidate)!==provenanceDigest)throw Error('systemd-source-review-not-current');
      const attempt={id:randomUUID(),reviewId,status:'started' as const};state.attempts.push(attempt);delete state.currentReviewId;await store.save(state);
      let result:{status:'blocked'|'incomplete'|'promoted'|'verification-failed';ok:boolean;promoted:boolean;[key:string]:unknown};
      try{
        const measured=await check(join(directory,'checks',attempt.id));
        if(!measured.passed||!measured.facts||factsDigest(measured.facts)!==review.factsDigest||contract()!==review.checkContractDigest){result={status:'blocked',ok:false,promoted:false,reason:'fresh-preflight-or-unit-facts-changed',checks:measured.checks};}
        else if(fingerprintPlan(await engine.plan(graph))!==review.masterReview.planDigest){result={status:'blocked',ok:false,promoted:false,reason:'reviewed-plan-changed',checks:measured.checks};}
        else{
          adapter.permit(measured.facts);const deployment=await master.apply(review.masterReview.reviewId);
          if(!deployment.ok)result={status:'incomplete',ok:false,promoted:false,reason:'inspect-native-systemd-outcome-before-retry',deployment,checks:measured.checks};
          else{
            const common={directory:join(directory,'checks',attempt.id),stageId:'application',releaseId:graph.name,releaseDigest:graph.digest,target};
            const beforeContract=contract();
            const verified=await runDeploymentChecks(beforeContract===review.checkContractDigest?application:contractCheck(review.checkContractDigest,beforeContract),common);
            const afterContract=contract();
            const contractFailure=afterContract!==review.checkContractDigest&&beforeContract===review.checkContractDigest
              ?await runDeploymentChecks(contractCheck(review.checkContractDigest,afterContract),{...common,stageId:'application-contract'}):undefined;
            const passed=beforeContract===review.checkContractDigest&&afterContract===review.checkContractDigest&&verified.status==='passed'&&verified.recording?.complete===true;
            result={status:passed?'promoted':'verification-failed',ok:passed,promoted:passed,deployment,checks:measured.checks,applicationChecks:contractFailure??verified,
              ...(contractFailure?{measuredApplicationChecks:verified}:{}),...(!passed&&afterContract!==review.checkContractDigest?{reason:'approved-check-contract-changed'}:{})};
          }
        }
      }catch{result={status:'incomplete',ok:false,promoted:false,reason:'inspect-native-systemd-outcome-before-retry'};}
      const saved=state.attempts.find(value=>value.id===attempt.id)!;saved.status=result.status;saved.result=result;await store.save(state);return{kind:'systemd-deployment-result',reviewId,...result};
    });},
  };
}
