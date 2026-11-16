import {flowChart} from 'footprintjs';
import {onboardingVersionScopeFactory,type OnboardingVersionScope} from './scope.ts';
import {bindVersionStage,inspectVersionStage,decideVersionStage,type VersionStageConfiguration} from './stages.ts';
/** Configuration ownership changes only; resource planning and deployment stay in the existing strategy. */
export function createOnboardingVersionChart(config:VersionStageConfiguration){return flowChart<void,OnboardingVersionScope>('Bind stable target and registry head',bindVersionStage(config),'bind')
 .setScopeFactory(onboardingVersionScopeFactory).addFunction('Inspect all retained owners',inspectVersionStage(config),'inspect')
 .addFunction('Review guarded configuration transition',decideVersionStage(config),'decide').build();}
