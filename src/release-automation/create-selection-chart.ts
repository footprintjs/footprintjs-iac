import {flowChart} from 'footprintjs';
import {AutomationScope,automationScopeFactory,initializeAutomation,type AutomationStages} from './stages.ts';
import type {ReleaseSelectionStrategy} from './types.ts';
import {freeze,jsonCopy} from '../graph/data.ts';
export function createReleaseSelectionChart(config:AutomationStages,strategy:ReleaseSelectionStrategy,eligibleIds:readonly string[],selected:(id:string|undefined)=>void){
  return flowChart<void,AutomationScope>('Choose next published version',initializeAutomation(config),'admit').setScopeFactory(automationScopeFactory)
    .addFunction('Record eligible versions',scope=>{scope.getValue('definitionDigest');scope.setValue('candidates',{choices:config.state.choices,eligibleIds:[...eligibleIds],strategyId:strategy.id});},'candidates')
    .addFunction('Choose next version',scope=>{const input=scope.getValue('candidates') as {choices:typeof config.state.choices;eligibleIds:string[]};const allowed=new Set(input.eligibleIds);
      const id=strategy.select(freeze(jsonCopy({choices:input.choices,eligibleIds:input.eligibleIds})) as unknown as Parameters<ReleaseSelectionStrategy['select']>[0]);
      if(id!==undefined&&!allowed.has(id))throw Error('Release strategy selected an ineligible source');selected(id);scope.setValue('selection',{releaseId:id??null,strategyId:strategy.id});},'select').build();
}
