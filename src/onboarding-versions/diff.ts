import type {OnboardingVersionDescriptor,OnboardingVersionChange} from './types.ts';
/** Desired configuration diff only. Resource compatibility and replacement remain the native planner's responsibility. */
export function diffOnboardingVersions(from:OnboardingVersionDescriptor,to:OnboardingVersionDescriptor):OnboardingVersionChange[]{
 const changes:OnboardingVersionChange[]=[];for(const [field,key]of [['release','releaseDigest'],['checks','checksDigest'],['profile','profileDigest']] as const)if(from[key]!==to[key])changes.push({field,before:from[key],after:to[key]});
 if(from.definition.configurationDigest!==to.definition.configurationDigest)changes.push({field:'configuration',before:from.definition.configurationDigest,after:to.definition.configurationDigest});return changes;
}
