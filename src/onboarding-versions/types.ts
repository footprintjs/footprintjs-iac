import type {CombinedRecorder} from 'footprintjs';
import type {OnboardingAction,OnboardingPreset,OnboardingPresetDefinition,OnboardingSnapshot} from '../onboarding/types.ts';
/** Stable physical ownership. Desired release, profile, unit configuration and check digests do not belong here. */
export interface OnboardingVersionOwner {id:string;strategyId:string;targetId:string;physicalTargetDigest:string;controllerId:string;controllerDigest:string}
export interface OnboardingVersionDescriptor {id:string;label:string;definition:OnboardingPresetDefinition;bindingDigest:string;releaseDigest:string;checksDigest:string;profileDigest:string}
export interface OnboardingVersionRegistration {
 id:string;label:string;releaseDigest:string;checksDigest:string;profileDigest:string;
 /** Explicit trusted legacy enrollment. There is no discovery/adoption of arbitrary state directories. */
 legacy?:{sessionDirectory:string;workflowDirectory:string};
 /** Pure composition. Use the supplied private paths, keep the same native controller, and fence exported CLI effects with withActiveVersion. */
 createPreset(input:{versionId:string;sessionDirectory:string;workflowDirectory:string;withActiveVersion<T>(work:()=>Promise<T>):Promise<T>}):OnboardingPreset;
}
export interface OnboardingOwnerStatus {ownerId:string;status:'closed'|'pending'|'unknown';digest:string;runId?:string}
export interface OnboardingOwnershipObservation {owner:OnboardingVersionOwner;hosts:readonly (OnboardingOwnerStatus&{versionId:string})[];native:OnboardingOwnerStatus}
export interface OnboardingOwnershipGuard {
 id:string;configurationDigest:string;
 /** Lock all participating retained host owners, then the shared native controller, until work settles. This port performs no installation/restart. */
 withLock<T>(work:()=>Promise<T>):Promise<T>;
 /** Read every requested original host owner even if a newer native resource attempt succeeded. No pending intent may be hidden by a newer graph. */
 inspect(input:{versionIds:readonly string[]}):Promise<OnboardingOwnershipObservation>;
}
export interface OnboardingVersionChange {field:'release'|'checks'|'profile'|'configuration';before:string;after:string}
export interface OnboardingVersionBlocker {ownerId:string;kind:'onboarding'|'host'|'native'|'registry';status:'pending'|'unknown'|'changed';runId?:string}
export interface OnboardingVersionReview {
 reviewId:string;fromVersionId:string;toVersionId:string;head:number;eligible:boolean;noop:boolean;
 changes:readonly OnboardingVersionChange[];blockers:readonly OnboardingVersionBlocker[];recording?:{runId:string};
}
export interface OnboardingVersionSnapshot {
 id:string;label:string;owner:OnboardingVersionOwner;head:number;activeVersionId:string;active:OnboardingSnapshot;
 versions:readonly OnboardingVersionDescriptor[];
 status:'idle'|'reviewed'|'blocked'|'activating'|'incomplete';busy:boolean;
 canReview:boolean;canActivate:boolean;canReconcile:boolean;
 review?:OnboardingVersionReview;
 history:readonly {head:number;versionId:string;workflow:OnboardingSnapshot;recording?:{runId:string}}[];
 recording?:{runId:string};error?:string;
}
export type OnboardingVersionAction={action:'review-version';versionId:string}|{action:'activate-version'|'reconcile-activation';reviewId:string}|{action:'refresh'};
export interface OnboardingVersionRegistryOptions {id:string;label:string;directory:string;owner:OnboardingVersionOwner;initialVersionId:string;versions:readonly OnboardingVersionRegistration[];guard:OnboardingOwnershipGuard;recorders?:readonly CombinedRecorder[]}
/** Dynamic facade, not an escaped reference to a retired immutable workflow. */
export interface ActiveOnboardingWorkflow {snapshot():Promise<OnboardingSnapshot>;dispatch(action:OnboardingAction):Promise<OnboardingSnapshot>;recording():Promise<unknown>;subscribe(listener:(value:OnboardingSnapshot)=>void):()=>void}
