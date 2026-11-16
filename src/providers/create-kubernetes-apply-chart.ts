import { createAdapterFlowChart } from '../adapter-flow/create-chart.ts';
import type { AdapterFlowContext } from '../adapter-flow/types.ts';
import type { Observation } from '../types.ts';

/** Actual kubectl boundaries; no synthetic API-server/controller internals. */
export function createKubernetesApplyChart(binding:AdapterFlowContext,ports:{
  prepare():Promise<Observation>;mutate():Promise<void>;wait():Promise<void>;observe():Promise<Observation>;
}){
  return createAdapterFlowChart(binding,[
    {id:'kubernetes-revalidate',name:'Read Kubernetes identity and mutation preconditions',phase:'revalidate',async run(scope){
      const observed=await ports.prepare();scope.progress(binding,'revalidate','passed',{componentId:binding.resourceId,installed:observed.exists,...(observed.ready===undefined?{}:{running:observed.ready})});
    }},
    {id:'kubernetes-mutate',name:'Create or conditionally update Kubernetes object',phase:'apply',async run(){await ports.mutate();}},
    {id:'kubernetes-ready',name:'Wait for Kubernetes readiness',phase:'observe',async run(){await ports.wait();}},
    {id:'kubernetes-observe',name:'Observe installed Kubernetes component',phase:'observe',async run(scope){
      const observed=await ports.observe();scope.progress(binding,'observe','passed',{componentId:binding.resourceId,installed:observed.exists,running:observed.ready===true});
    }},
  ]);
}
