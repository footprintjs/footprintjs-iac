import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
import { ADAPTER_FLOW_EVENT, type AdapterFlowContext, type AdapterFlowOutcome, type AdapterFlowPhase, type AdapterFlowProgress, type AdapterFlowStatus } from './types.ts';

export class AdapterFlowScope extends ScopeFacade {
  get adapterFlowPassed(): boolean { return this.getValue('adapterFlowPassed') as boolean; }
  get outcome(): AdapterFlowOutcome { return this.getValue('adapterFlowOutcome') as AdapterFlowOutcome; }
  /** Explicit terminal component measurements win over the generic wrapper completion. */
  completePhase(binding:AdapterFlowContext,phase:AdapterFlowPhase,componentId?:string):void {
    if(componentId){
      const current=this.getValue(`adapterComponent:${componentId}`) as AdapterFlowProgress|undefined;
      if(current?.phase===phase&&current.componentId===componentId&&current.status!=='running'
        &&current.deploymentRunId===binding.deploymentRunId&&current.resourceId===binding.resourceId
        &&current.adapterId===binding.adapterId&&current.operationId===binding.operationId)return;
    }
    this.progress(binding,phase,'passed',componentId?{componentId}:{});
  }
  progress(binding: AdapterFlowContext, phase: AdapterFlowPhase, status: AdapterFlowStatus, facts: Pick<AdapterFlowProgress,'componentId'|'installed'|'running'> = {}): void {
    // Read the mounted input so recorded child observations retain their parent data provenance.
    void this.getValue('adapterFlowInput');
    const payload = { version: 1 as const, deploymentRunId:binding.deploymentRunId,adapterId:binding.adapterId,resourceId:binding.resourceId,operationId:binding.operationId, phase, status,
      ...(facts.componentId===undefined?{}:{componentId:facts.componentId}),...(facts.installed===undefined?{}:{installed:facts.installed}),...(facts.running===undefined?{}:{running:facts.running}) };
    this.setValue('adapterFlowProgress', payload);
    if(facts.componentId)this.setValue(`adapterComponent:${facts.componentId}`,payload);
    this.emitEvent(ADAPTER_FLOW_EVENT, payload);
  }
}
export const adapterFlowScopeFactory: ScopeFactory<AdapterFlowScope> = (context, name, readOnly, environment) => new AdapterFlowScope(context, name, readOnly, environment);
