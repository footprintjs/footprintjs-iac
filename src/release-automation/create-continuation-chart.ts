import {flowChart} from 'footprintjs';
import {AutomationScope,automationScopeFactory,initializeAutomation,type AutomationStages} from './stages.ts';
import {projectReleaseAutomationAttempt} from './project.ts';
export function createReleaseContinuationChart(config:AutomationStages,continuePipeline:()=>Promise<void>){
  return flowChart<void,AutomationScope>('Continue approved release',initializeAutomation(config),'admit').setScopeFactory(automationScopeFactory)
    .addFunction('Continue exact pipeline gate',async scope=>{scope.getValue('request');scope.getValue('definitionDigest');await continuePipeline();scope.setValue('outcome',projectReleaseAutomationAttempt(config.attempt!));},'continue').build();
}
