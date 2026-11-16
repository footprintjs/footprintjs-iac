import { flowChart } from 'footprintjs';
import { ONBOARDING_STAGE_LABELS } from './data.ts';
import { onboardingScopeFactory, type OnboardingScope } from './scope.ts';
import { admitOnboardingStage, bindOnboardingStage, observeOnboardingStage, onboardingStageId, type OnboardingStageConfiguration } from './stages.ts';
/** One native transition. Human review separates invocations; deployment authority stays in the registered strategy. */
export function createOnboardingChart(config:OnboardingStageConfiguration){
 const stageId=onboardingStageId(config.entry.action.action);
 return flowChart<void,OnboardingScope>('Bind registered onboarding target',bindOnboardingStage(config),'bind')
  .setScopeFactory(onboardingScopeFactory)
  .addFunction(config.entry.action.action==='reconcile'?'Inspect original deployment outcome':ONBOARDING_STAGE_LABELS[stageId],observeOnboardingStage(config),stageId)
  .addFunction('Retain measured outcome',admitOnboardingStage(config),'retain').build();
}
