import {canonical,fingerprint} from '../util.ts';
import type {OnboardingVersionScope} from './scope.ts';
import type {RegistryEntry,RegistryState,CapturedVersion} from './state.ts';
import {versionBlocker} from './state.ts';
import {diffOnboardingVersions} from './diff.ts';
import {observeVersionOwners} from './ownership.ts';
import type {OnboardingOwnershipGuard,OnboardingVersionOwner,OnboardingVersionChange} from './types.ts';
export interface VersionStageConfiguration {state:RegistryState;entry:RegistryEntry;owner:OnboardingVersionOwner;guard:OnboardingOwnershipGuard;retained:readonly CapturedVersion[];candidate:CapturedVersion;expectedObservationDigest?:string;persist():Promise<void>}
export const sealVersionReview=(entry:RegistryEntry)=>fingerprint({review:entry.review,observationDigest:entry.observation?.digest});
export function bindVersionStage(c:VersionStageConfiguration){return async(scope:OnboardingVersionScope)=>{scope.setValue('owner',c.owner);scope.setValue('operationId',c.entry.id);scope.setValue('action',c.entry.action);scope.setValue('head',c.entry.head);scope.setValue('fromVersionId',c.entry.fromVersionId);scope.setValue('candidate',c.candidate.descriptor);scope.setValue('reconciles',c.entry.reconciles??[]);await c.persist();};}
export function inspectVersionStage(c:VersionStageConfiguration){return async(scope:OnboardingVersionScope)=>{if(canonical(scope.getValue('owner'))!==canonical(c.owner)||scope.getValue('head')!==c.state.head||scope.getValue('fromVersionId')!==c.state.activeVersionId)throw Error('Registry head changed');const measured=await observeVersionOwners({versions:c.retained,owner:c.owner,guard:c.guard});c.entry.observation=measured.observation;c.entry.review.blockers=measured.blockers;scope.setValue('observations',measured);await c.persist();};}
export function decideVersionStage(c:VersionStageConfiguration){return async(scope:OnboardingVersionScope)=>{
 scope.getValue('observations');const current=c.state.descriptors.find(version=>version.id===c.state.activeVersionId)!,candidate=c.candidate.descriptor;
 const changes=diffOnboardingVersions(current,candidate);
 if(!c.state.history.some(row=>row.versionId===candidate.id)){const view=await c.candidate.workflow.snapshot();if(view.status!=='idle'||view.busy||view.recording||view.review||view.deployment||view.checks.length||view.stages.some(stage=>stage.status!=='pending'))c.entry.review.blockers=[...c.entry.review.blockers,versionBlocker(candidate.id,'registry','changed')];}
 if(changes.length===0&&current.bindingDigest!==candidate.bindingDigest)c.entry.review.blockers=[...c.entry.review.blockers,versionBlocker(candidate.id,'registry','changed')];
 if(c.state.history.some(row=>row.versionId===candidate.id)&&candidate.id!==c.state.activeVersionId)c.entry.review.blockers=[...c.entry.review.blockers,versionBlocker(candidate.id,'registry','changed')];
 if(c.entry.action.action==='activate-version'&&(!c.entry.observation||c.entry.observation.digest!==c.expectedObservationDigest))c.entry.review.blockers=[...c.entry.review.blockers,versionBlocker(c.owner.id,'registry','changed')];
 c.entry.review={...c.entry.review,changes,eligible:c.entry.review.blockers.length===0,noop:changes.length===0};
 if(c.entry.action.action==='reconcile-activation'){
  // The registry pointer is atomically stored with its admitted capture. Reconciliation closes a missing acknowledgement; it never advances the head.
  c.entry.outcome=c.entry.review.eligible?'reconciled-failed':'blocked';
 }else if(c.entry.action.action==='activate-version'&&c.entry.review.eligible){c.entry.proposal=changes.length===0?{head:c.state.head,versionId:c.state.activeVersionId}:{head:c.state.head+1,versionId:candidate.id};c.entry.outcome='activated';}
 else c.entry.outcome=c.entry.review.eligible?'reviewed':'blocked';
 c.entry.reviewSeal=sealVersionReview(c.entry);scope.setValue('review',c.entry.review);scope.setValue('reviewSeal',c.entry.reviewSeal);scope.setValue('outcome',c.entry.outcome);scope.setValue('proposal',c.entry.proposal??null);scope.setValue('recordingComplete',true);await c.persist();
};}
