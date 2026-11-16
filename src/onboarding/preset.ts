import { freeze, identifier } from '../graph/data.ts';
import { onboardingDigest, readOnboardingDefinition } from './data.ts';
import type { OnboardingCheckAdapter, OnboardingPreset } from './types.ts';
/** Capture a registered composition without observing providers, installing software or opening files. */
export function createOnboardingPreset(input:OnboardingPreset):OnboardingPreset {
 const definition=readOnboardingDefinition(input.definition),deployment=input.deployment;
 if(!deployment||['plan','apply','snapshot'].some(key=>typeof deployment[key as keyof typeof deployment]!=='function')||deployment.id!==definition.strategyId)throw Error('Register the matching onboarding deployment strategy');
 identifier(deployment.kind,'onboarding strategy kind');
 const captured=Object.fromEntries((['discover','configure','verify'] as const).map(stage=>{const adapter=input.adapters?.[stage];if(!adapter||typeof adapter.run!=='function'||!Array.isArray(adapter.requiredCheckIds)||!adapter.requiredCheckIds.length||adapter.requiredCheckIds.length>128)throw Error('Register complete onboarding observations');const ids=adapter.requiredCheckIds.map(id=>identifier(id,'onboarding required check'));if(new Set(ids).size!==ids.length)throw Error('Duplicate onboarding required check');return[stage,Object.freeze({id:identifier(adapter.id,'onboarding adapter'),configurationDigest:onboardingDigest(adapter.configurationDigest),requiredCheckIds:freeze([...ids]),run:adapter.run.bind(adapter)})];})) as unknown as Record<'discover'|'configure'|'verify',OnboardingCheckAdapter>;
 if(input.projectReview!==undefined&&typeof input.projectReview!=='function')throw Error('Register a pure onboarding review projection');
 if(input.projectDeployment!==undefined&&typeof input.projectDeployment!=='function')throw Error('Register a pure onboarding deployment projection');
 const registered={id:deployment.id,kind:deployment.kind,plan:deployment.plan.bind(deployment),apply:deployment.apply.bind(deployment),snapshot:deployment.snapshot.bind(deployment),...(deployment.reconcile?{reconcile:deployment.reconcile.bind(deployment)}:{})};
 return Object.freeze({definition,deployment:Object.freeze(registered),adapters:Object.freeze(captured),...(input.projectReview?{projectReview:input.projectReview}:{}),...(input.projectDeployment?{projectDeployment:input.projectDeployment}:{})});
}
