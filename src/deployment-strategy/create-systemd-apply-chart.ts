import { decide, flowChart, type FlowChart } from 'footprintjs';
import { adapterFlowScopeFactory, type AdapterFlowScope } from '../adapter-flow/scope.ts';
import type { AdapterFlowContext } from '../adapter-flow/types.ts';

/** Mount the host recipe only after consuming the exact reviewed one-use permit. */
export function createSystemdApplyChart(binding:AdapterFlowContext,host:FlowChart<any,any>,admit:(scope:AdapterFlowScope)=>Promise<void>){
  return flowChart<void,AdapterFlowScope>('Revalidate reviewed systemd permit',async scope=>{
    void scope.getValue('adapterFlowInput');scope.progress(binding,'revalidate','running');
    try{await admit(scope);scope.setValue('adapterFlowOutcome',{status:'passed'});scope.setValue('adapterFlowPassed',true);scope.progress(binding,'revalidate','passed');}
    catch{scope.setValue('adapterFlowOutcome',{status:'failed',code:'systemd-review-changed'});scope.setValue('adapterFlowPassed',false);scope.progress(binding,'revalidate','failed');}
  },'systemd-permit').setScopeFactory(adapterFlowScopeFactory)
    .addDeciderFunction('Was the reviewed host admitted?',scope=>decide(scope,[{when:{adapterFlowPassed:{eq:true}},then:'systemd-host',label:'Fresh facts match one-use permit'}],'systemd-refused'),'systemd-host-gate')
    .addSubFlowChartBranch('systemd-host',host,'Registered systemd host operation',{
      inputMapper:scope=>({adapterFlowInput:(scope as Record<string,unknown>).adapterFlowInput}),
      outputMapper:output=>({adapterFlowOutcome:(output as Record<string,unknown>).adapterFlowOutcome}),
    }).addFunctionBranch('systemd-refused','Keep existing services unchanged',()=>undefined).setDefault('systemd-refused').end().build();
}
