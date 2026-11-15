import { flowChart } from 'footprintjs';
import { componentBatches } from './declaration.ts';
import { createAgentComponentSubflow } from './create-component-subflow.ts';
import { agentComponentsScopeFactory, type AgentComponentsScope } from './scope.ts';
import { componentStageId, skippedStageId, loadComponentGraphStage, selectComponentBatch, retainComponentStage, joinComponentBatch, finishComponentGraphStage, type ComponentChartStages } from './stages.ts';

/** Sole construction point: native selectors fork disjoint child lifecycles and join before dependencies. */
export function createAgentComponentChart(config: ComponentChartStages, maxConcurrency: number) {
 let chart = flowChart<void, AgentComponentsScope>('Load agent components', loadComponentGraphStage(config), 'load-components').setScopeFactory(agentComponentsScopeFactory);
 for (const [index, batch] of componentBatches(config.definition, maxConcurrency).entries()) {
  const selector = chart.addSelectorFunction('Select component batch ' + index, selectComponentBatch(config, batch), 'select-components-' + index);
  for (const id of batch) {
   selector.addSubFlowChartBranch(componentStageId(id), createAgentComponentSubflow(config, id), 'Prepare component: ' + id, { outputMapper: output => ({ ['component:' + id]: output['component:' + id] }) });
   selector.addFunctionBranch(skippedStageId(id), 'Retain component: ' + id, retainComponentStage(config, id));
  }
  chart = selector.end().addFunction('Join component batch ' + index, joinComponentBatch(config, batch), 'join-components-' + index);
 }
 return chart.addFunction('Confirm agent component readiness', finishComponentGraphStage(config), 'confirm-components').build();
}
