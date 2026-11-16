import {canonical,fingerprint} from '../util.ts';
import {readOwnershipObservation} from './data.ts';
import {versionBlocker,type CapturedVersion,type RegistryObservation} from './state.ts';
import type {OnboardingOwnershipGuard,OnboardingVersionOwner,OnboardingVersionBlocker} from './types.ts';
/** Called only under retained workflow locks and the trusted host/native guard lease. */
export async function observeVersionOwners(input:{versions:readonly CapturedVersion[];owner:OnboardingVersionOwner;guard:OnboardingOwnershipGuard}):Promise<{observation?:RegistryObservation;blockers:OnboardingVersionBlocker[]}>{
 const blockers:OnboardingVersionBlocker[]=[],workflows:RegistryObservation['workflows']=[];
 for(const version of input.versions){try{const view=await version.workflow.snapshot();workflows.push({versionId:version.descriptor.id,status:view.status,busy:view.busy,canDeploy:view.canDeploy,configurationDigest:view.configurationDigest,...view.recording?{recording:view.recording}:{}});if(view.busy||view.status==='incomplete'||view.canDeploy||view.status==='reviewed')blockers.push(versionBlocker(version.descriptor.id,'onboarding',view.busy||view.canDeploy||view.status==='reviewed'?'pending':'unknown',view.recording?.runId));}catch{blockers.push(versionBlocker(version.descriptor.id,'onboarding','unknown'));}}
 try{const ownership=readOwnershipObservation(await input.guard.inspect({versionIds:input.versions.map(version=>version.descriptor.id)}),input.versions.map(version=>version.descriptor.id));
  if(canonical(ownership.owner)!==canonical(input.owner))blockers.push(versionBlocker(input.owner.id,'registry','changed'));
  if(ownership.native.ownerId!==input.owner.controllerId)blockers.push(versionBlocker(input.owner.controllerId,'native','changed'));
  for(const host of ownership.hosts)if(host.status!=='closed')blockers.push(versionBlocker(host.ownerId,'host',host.status==='pending'?'pending':'unknown',host.runId));
  if(ownership.native.status!=='closed')blockers.push(versionBlocker(ownership.native.ownerId,'native',ownership.native.status==='pending'?'pending':'unknown',ownership.native.runId));
  const observation={workflows,ownership,digest:fingerprint({workflows,ownership})};return{observation,blockers};
 }catch{blockers.push(versionBlocker(input.owner.id,'registry','unknown'));return{blockers};}
}
