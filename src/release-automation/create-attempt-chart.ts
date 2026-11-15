import {flowChart} from 'footprintjs';
import {AutomationScope,automationScopeFactory,initializeAutomation,resolveRelease,prepareRelease,launchRelease,sealAutomation,type AutomationStages} from './stages.ts';
/** Child workflows keep their own native runs; receipt links never invent cross-run causal edges. */
export function createReleaseAutomationChart(config:AutomationStages){
  return flowChart<void,AutomationScope>('Deploy published version',initializeAutomation(config),'admit').setScopeFactory(automationScopeFactory)
    .addFunction('Pin exact source',resolveRelease(config),'resolve')
    .addFunction('Build version once',prepareRelease(config),'prepare')
    .addFunction('Start environment pipeline',launchRelease(config),'launch')
    .addFunction('Retain outcome',sealAutomation(config),'seal').build();
}
