import { createAdapterFlowChart, type AdapterPhase } from '../adapter-flow/create-chart.ts';
import type { AdapterFlowContext } from '../adapter-flow/types.ts';
import type { SystemdApplyContext, SystemdGroupApplyContext, SystemdGroupApplyRequest, SystemdUnitApplyRequest, SystemdUnitObservation } from './types.ts';

export interface SystemdNativeHostPorts {
  command(phase:'revalidate'|'configure'|'reload'|'start',request:SystemdUnitApplyRequest|SystemdGroupApplyRequest,context:SystemdApplyContext|SystemdGroupApplyContext):Promise<void>;
  observe(unit:string,request:SystemdUnitApplyRequest|SystemdGroupApplyRequest,context:SystemdApplyContext|SystemdGroupApplyContext):Promise<SystemdUnitObservation>;
}
/** Real host commands, one atomic restart of the registered group, then individual measured reads. */
export function createSystemdHostApplyChart(request:SystemdUnitApplyRequest|SystemdGroupApplyRequest,context:SystemdApplyContext|SystemdGroupApplyContext,
  binding:AdapterFlowContext&{components:readonly {componentId:string;unit:string}[]},ports:SystemdNativeHostPorts) {
  const phases:AdapterPhase[]=(['revalidate','configure','reload','start'] as const).map(phase=>({id:`systemd-${phase}`,name:{revalidate:'Revalidate registered services',configure:'Write managed release markers',reload:'Reload systemd configuration',start:'Restart service transaction'}[phase],phase,
    async run(){await ports.command(phase,request,context);}}));
  for(const component of binding.components)phases.push({id:`systemd-observe-${component.componentId}`,name:`Observe ${component.componentId}`,phase:'observe',componentId:component.componentId,async run(scope){
    const observed=await ports.observe(component.unit,request,context);
    scope.progress(binding,'observe','passed',{componentId:component.componentId,installed:observed.exists,running:observed.activeState==='active'});
  }});
  return createAdapterFlowChart(binding,phases);
}
