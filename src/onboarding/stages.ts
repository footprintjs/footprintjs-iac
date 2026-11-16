import { randomUUID } from 'node:crypto';
import { canonical } from '../util.ts';
import { ONBOARDING_STAGE_LABELS, onboardingObject, readOnboardingChecks, readOnboardingChanges, readOnboardingSnapshot } from './data.ts';
import { onboardingPermissions } from './permissions.ts';
import type { OnboardingScope } from './scope.ts';
import type { OnboardingEntry, OnboardingState } from './state.ts';
import type { OnboardingPreset, OnboardingSnapshot, OnboardingStageId, OnboardingCheck } from './types.ts';
export const ONBOARDING_PROGRESS_EVENT='iac:onboarding-progress';
export interface OnboardingStageConfiguration {preset:OnboardingPreset;bindingDigest:string;state:OnboardingState;entry:OnboardingEntry;persist():Promise<void>}
export const onboardingStageId=(action:string):OnboardingStageId=>action==='reconcile'?'deploy':action as OnboardingStageId;
export function bindOnboardingStage(c:OnboardingStageConfiguration){return async(scope:OnboardingScope)=>{scope.setValue('preset',c.preset.definition);scope.setValue('bindingDigest',c.bindingDigest);scope.setValue('operationId',c.entry.id);scope.setValue('action',c.entry.action);scope.setValue('before',c.entry.before);await c.persist();};}
export function observeOnboardingStage(c:OnboardingStageConfiguration){return async(scope:OnboardingScope)=>{
 if(scope.getValue('bindingDigest')!==c.bindingDigest||scope.getValue('operationId')!==c.entry.id||canonical(scope.getValue('preset'))!==canonical(c.preset.definition)||canonical(scope.getValue('action'))!==canonical(c.entry.action))throw Error('Onboarding binding changed');
 const action=c.entry.action.action,stageId=onboardingStageId(action);let view=structuredClone(c.state.view);let measuredApplicationChecks:readonly OnboardingCheck[]|undefined;
 scope.emitEvent(ONBOARDING_PROGRESS_EVENT,{stageId,status:'running'});
 try {
  if(action==='discover'||action==='configure'||action==='verify'){
   const adapter=c.preset.adapters[action],checks=readOnboardingChecks(await adapter.run({targetId:c.preset.definition.targetId,...c.preset.definition.profileId?{profileId:c.preset.definition.profileId}:{}}));
   const required=adapter.requiredCheckIds,complete=required.every(id=>checks.some(check=>check.id===id&&check.status==='passed'));
   const allChecks=[...checks];for(const id of required)if(!allChecks.some(check=>check.id===id))allChecks.push({id,label:id,status:'unknown'});
   view.checks=readOnboardingChecks(allChecks);view.status=complete&&checks.every(check=>check.status==='passed')?action==='discover'?'discovered':action==='configure'?'configured':'verified':'failed';
   view.stages=view.stages.map(stage=>stage.id===stageId?{...stage,status:view.status==='failed'?allChecks.some(check=>check.status==='unknown')?'unknown':'failed':'passed'}:stage);
   if(view.status==='failed')view.error='The registered observations did not confirm all required checks.';
  }else if(action==='review'){
   const result=await c.preset.deployment.plan({revisionId:randomUUID()});
   const changes=readOnboardingChanges(c.preset.projectReview?c.preset.projectReview(result):[]);
   const ok=result.ok===true&&!!result.reviewId&&!changes.some(change=>change.action==='blocked');
   view.review={ok,...ok?{reviewId:result.reviewId}:{},changes};view.status=ok?'reviewed':'failed';view.stages=view.stages.map(stage=>stage.id==='review'?{...stage,status:ok?'passed':'failed'}:stage);
   if(!ok)view.error='The deployment strategy could not approve this change.';
  }else if(action==='deploy'){
   const result=await c.preset.deployment.apply((c.entry.action as {reviewId:string}).reviewId);
   const admitted=onboardingObject({ok:result.ok,promoted:result.promoted,status:result.status},['ok','promoted','status']);
   const status=admitted.status as NonNullable<OnboardingSnapshot['deployment']>['status'];
   if(typeof admitted.ok!=='boolean'||typeof admitted.promoted!=='boolean'||!['promoted','blocked','apply-failed','verification-failed','incomplete'].includes(status)||admitted.ok!==admitted.promoted||admitted.promoted!==(status==='promoted'))throw Error('Invalid strategy deployment result');
   const applicationChecks=c.preset.projectDeployment?readOnboardingChecks(c.preset.projectDeployment(result)):undefined;
   if(applicationChecks){measuredApplicationChecks=applicationChecks;view.checks=applicationChecks;if(admitted.promoted&&applicationChecks.some(check=>check.status!=='passed'))throw Error('Onboarding application promotion differs from measured checks');}
   view.deployment={ok:admitted.ok,promoted:admitted.promoted,status,...applicationChecks?{checks:applicationChecks}:{}};view.status=status==='promoted'?'ready':status==='incomplete'?'incomplete':'failed';
   view.stages=view.stages.map(stage=>stage.id==='deploy'?{...stage,status:status==='promoted'?'passed':status==='incomplete'?'unknown':'failed'}:stage);
   if(view.status!=='ready')view.error=view.status==='incomplete'?'The deployment outcome is uncertain. Inspect the original attempt before continuing.':'The deployment or its required application checks did not pass.';
  }else if(action==='reconcile'){
   const result=await c.preset.deployment.reconcile!((c.entry.action as {reviewId:string}).reviewId);
   if(result.ok!==false||result.promoted!==false||!['reconciled-failed','incomplete'].includes(result.status))throw Error('Invalid reconciliation result');
   view.status=result.status==='reconciled-failed'?'failed':'incomplete';view.deployment={ok:false,promoted:false,status:result.status==='reconciled-failed'?'apply-failed':'incomplete'};view.stages=view.stages.map(stage=>stage.id==='deploy'?{...stage,status:view.status==='incomplete'?'unknown':'failed'}:stage);
   view.error=view.status==='incomplete'?'The original deployment outcome remains uncertain.':'The original attempt is closed as failed. Discover and review a fresh change.';
  }
 }catch{
  const uncertain=action==='deploy'||action==='reconcile';view.status=uncertain?'incomplete':'failed';view.stages=view.stages.map(stage=>stage.id===stageId?{...stage,status:uncertain?'unknown':'failed'}:stage);view.error=uncertain?'The deployment outcome is uncertain. Inspect retained native evidence before another attempt.':'The registered onboarding stage could not be checked.';
  if(uncertain)view.deployment={ok:false,promoted:false,status:'incomplete',...(measuredApplicationChecks?{checks:measuredApplicationChecks}:{})};
 }
 view.busy=false;view=onboardingPermissions(view,typeof c.preset.deployment.reconcile==='function');c.state.view=view;c.entry.after=readOnboardingSnapshot(view);scope.setValue('after',c.entry.after);scope.setValue('outcome',{stageId,status:view.status});scope.emitEvent(ONBOARDING_PROGRESS_EVENT,{stageId,status:view.stages.find(stage=>stage.id===stageId)!.status});await c.persist();
};}
export function admitOnboardingStage(c:OnboardingStageConfiguration){return async(scope:OnboardingScope)=>{if(!c.entry.after||canonical(scope.getValue('after'))!==canonical(c.entry.after))throw Error('Onboarding measured result differs');scope.getValue('outcome');scope.setValue('recordingComplete',true);};}
