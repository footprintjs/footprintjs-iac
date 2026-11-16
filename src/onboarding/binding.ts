import { fingerprint } from '../util.ts';
import { createOnboardingPreset } from './preset.ts';
import type { OnboardingPreset } from './types.ts';
/** Immutable configuration provenance, not permission to switch state paths. Never replace a target/controller identity or bypass an unfinished session with this digest. */
export function onboardingBindingDigest(input:OnboardingPreset):string {
 const preset=createOnboardingPreset(input);
 return fingerprint({definition:preset.definition,strategy:{id:preset.deployment.id,kind:preset.deployment.kind},adapters:Object.fromEntries(Object.entries(preset.adapters).map(([stage,adapter])=>[stage,{id:adapter.id,configurationDigest:adapter.configurationDigest,requiredCheckIds:adapter.requiredCheckIds}]))});
}
