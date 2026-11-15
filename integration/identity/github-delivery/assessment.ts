import {dirname,join} from 'node:path';
import {ChangeAssessmentWorkflow,FileChangeAssessmentStore,conservativeChangeStrategy,
  loadChangeAssessmentRecording,readChangeAssessmentReport} from '../../../src/change-assessment/node.ts';
import {KubernetesChangeAssessmentAdapter,ownedBootstrapServerSideApplyValidation,type KubernetesAssessmentTransport} from '../../../src/change-assessment/kubernetes.ts';
import type {ChangeAssessmentDefinition,ChangeAssessmentAdapter,ChangeAssessmentReport,ChangeAssessmentState} from '../../../src/change-assessment/types.ts';
import type {MasterReview,SystemRevision} from '../../../src/master/types.ts';
import {canonical,fingerprint} from '../../../src/util.ts';
import type {IdentityTarget} from '../target.ts';
import {neoDeliveryTarget} from './target.ts';
import {neoKubernetesAssessmentTransport} from './assessment-transport.ts';
import type {NeoDeliveryObservation,NeoGithubDeliveryOptions} from './types.ts';
import {DeploymentPreflightRefused} from '../../../src/delivery/evidence.ts';

export interface NeoAssessmentReceipt {report:ChangeAssessmentReport;recording:NonNullable<ChangeAssessmentState['recording']>}
export interface NeoAssessmentInput {
  options:NeoGithubDeliveryOptions;current:IdentityTarget;directory:string;reviewId:string;
  previous:SystemRevision;revision:SystemRevision;review:MasterReview;phase:'plan'|'revalidate';
  emit(event:NeoDeliveryObservation):void;
}
function assessmentDefinition(input:NeoAssessmentInput):ChangeAssessmentDefinition{
  const {current,review,previous,revision,phase,reviewId}=input;
  if(review.candidateDigest!==revision.digest||review.parentDigest!==previous.digest
    ||canonical(previous.target)!==canonical(revision.target)||canonical(revision.target)!==canonical(neoDeliveryTarget(current)))throw Error('Neo assessment revision binding changed');
  return{version:1,id:'neo-'+phase+'-'+reviewId,label:phase==='plan'?'Check Neo changes':'Recheck Neo changes',target:neoDeliveryTarget(current),
    configurationDigest:fingerprint({version:1,mode:'ssa-owned-bootstrap',target:neoDeliveryTarget(current),previous:previous.digest,desired:revision.digest,plan:review.planDigest}),
    changes:revision.graph.resources.map(desired=>({id:desired.id,label:desired.id,adapterId:desired.provider==='kubernetes'?'neo-kubernetes-preflight':'neo-identity-preflight',
      strategyId:'conservative',data:desired.id==='neo-app'||desired.provider==='local-identity-fixture'?'unknown':'stateless',
      previous:previous.graph.resources.find(resource=>resource.id===desired.id),desired}))};
}
function admission(report:ChangeAssessmentReport,review:MasterReview):boolean{
  return report.changes.length===review.plan.operations.length&&report.changes.every(change=>{
    const operation=review.plan.operations.find(item=>item.resource.id===change.resourceId);
    return !!operation&&['noop','verify','update'].includes(change.disposition)&&change.disposition===operation.action
      &&(change.disposition!=='update'||change.resourceId==='neo-app')&&change.observed.exists&&change.observed.owned===true;
  });
}
/** All observations and dry-runs are read-only. Rejected reports are still emitted and retained. */
export async function assessNeoDeployment(input:NeoAssessmentInput):Promise<NeoAssessmentReceipt>{
  const definition=assessmentDefinition(input),scope=definition.target.scope;
  let loaded:Promise<KubernetesAssessmentTransport>|undefined;
  const transport:KubernetesAssessmentTransport={request(...args){
    // Credential/transport admission failures are themselves recorded as unavailable
    // provider facts instead of escaping before the native observation stage starts.
    loaded??=Promise.resolve().then(()=>(input.options.assessmentTransport??neoKubernetesAssessmentTransport)(input.current));
    return loaded.then(adapter=>adapter.request(...args));
  }};
  const identity:ChangeAssessmentAdapter={id:'neo-identity-preflight',provider:'local-identity-fixture',scope,
    async probe(change){
      const observed=input.review.plan.operations.find(operation=>operation.resource.id===change.id)?.observed;
      if(!observed)throw Error('Identity observation is absent');
      // These facts come from the master's actual just-completed provider observations.
      // Application releases have no declared capability to change identity containers.
      const unchanged=!!change.previous&&!!change.desired&&canonical(change.previous)===canonical(change.desired);
      return{observation:observed,update:unchanged?'not-needed':'rejected',validation:'declared-contract',
        reasons:[unchanged?'unchanged-observed-identity':'identity-change-needs-separate-plan']};
    }};
  const workflow=new ChangeAssessmentWorkflow({definition,
    registry:{adapters:[identity,new KubernetesChangeAssessmentAdapter({id:'neo-kubernetes-preflight',scope,stack:input.revision.graph.name,
      namespace:input.current.namespace,transport,validationStrategy:ownedBootstrapServerSideApplyValidation()})],strategies:[conservativeChangeStrategy()]},
    store:new FileChangeAssessmentStore(join(input.directory,'assessments',input.reviewId,input.phase))});
  const emit=(state:ChangeAssessmentState)=>input.emit({kind:'assessment',graph:input.revision.graph,phase:input.phase,
    status:state.status==='complete'?(state.report&&admission(state.report,input.review)?'checked':'blocked'):state.status==='incomplete'?'blocked':'checking',
    ...(state.report?{report:state.report}:{}),...(state.recording?{recording:state.recording}:{}),...(state.error?{error:'Neo preflight recording is incomplete'}:{})});
  const stop=workflow.subscribe(emit);
  let state:ChangeAssessmentState;try{state=await workflow.start();}finally{stop();}
  if(state.status!=='complete'||!state.report||!state.recording?.complete)throw new DeploymentPreflightRefused();
  if(!admission(state.report,input.review))throw new DeploymentPreflightRefused([{kind:'change-assessment-'+input.phase,digest:state.report.digest,runId:state.recording.runId}]);
  return{report:state.report,recording:state.recording};
}
/** Replays the sealed preflight rather than trusting a report copied into a plan. */
export async function admitNeoAssessmentReceipt(input:NeoAssessmentInput,receipt:NeoAssessmentReceipt):Promise<NeoAssessmentReceipt>{
  const definition=assessmentDefinition(input),report=readChangeAssessmentReport(receipt?.report),recording=receipt?.recording;
  const directory=join(input.directory,'assessments',input.reviewId,input.phase);
  if(!recording?.complete||dirname(recording.evidencePath)!==directory||dirname(recording.tracePath)!==directory
    ||recording.tracePath!==recording.evidencePath.replace(/\.json$/,'.jsonl')||report.definitionDigest!==fingerprint(definition)
    ||report.target.id!==definition.target.id||report.target.scopeDigest!==fingerprint(definition.target.scope))throw Error('Neo preflight receipt binding changed');
  const recorded=await loadChangeAssessmentRecording(recording.evidencePath,{runId:recording.runId,executionId:report.executionId,definitionDigest:report.definitionDigest});
  if(!recorded.complete||canonical((recorded.snapshot as {sharedState?:Record<string,unknown>}).sharedState?.report)!==canonical(report)
    ||!admission(report,input.review))throw Error('Neo preflight native report changed or is not executable');
  return{report,recording};
}
/** Exact identity/version/readiness/fingerprint facts must still match immediately before apply. */
export function assertNeoAssessmentUnchanged(reviewed:NeoAssessmentReceipt,current:NeoAssessmentReceipt):void{
  if(canonical(reviewed.report.changes)!==canonical(current.report.changes))throw new DeploymentPreflightRefused([
    {kind:'change-assessment-plan',digest:reviewed.report.digest,runId:reviewed.recording.runId},
    {kind:'change-assessment-revalidate',digest:current.report.digest,runId:current.recording.runId}]);
}
