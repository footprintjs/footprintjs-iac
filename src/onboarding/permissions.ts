import { readOnboardingSnapshot } from './data.ts';
import type { OnboardingSnapshot } from './types.ts';
/** Permissions are derived from durable measured stages; a view cannot grant deployment authority. */
export function onboardingPermissions(input:OnboardingSnapshot,reconcile:boolean):OnboardingSnapshot {
 const view=structuredClone(input),passed=(id:string)=>view.stages.some(row=>row.id===id&&row.status==='passed');
 const idle=!view.busy&&view.status!=='incomplete',clean=view.deployment===undefined;
 view.canDiscover=idle;view.canConfigure=idle&&passed('discover');view.canVerify=idle&&passed('configure');view.canReview=idle&&passed('verify');
 view.canDeploy=idle&&clean&&passed('review')&&view.review?.ok===true;
 view.canReconcile=!view.busy&&view.status==='incomplete'&&!!view.review?.reviewId&&reconcile;
 return readOnboardingSnapshot(view);
}
