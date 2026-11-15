import {flowChart} from 'footprintjs';
import {AutomationScope,automationScopeFactory,initializeAutomation,discoverReleases,type AutomationStages} from './stages.ts';
/** Native source discovery only; construction performs no catalog/provider calls. */
export function createReleaseDiscoveryChart(config:AutomationStages){
  return flowChart<void,AutomationScope>('Check published versions',initializeAutomation(config),'admit').setScopeFactory(automationScopeFactory)
    .addFunction('Discover versions',discoverReleases(config),'discover').build();
}
