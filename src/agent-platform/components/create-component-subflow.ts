import { flowChart } from 'footprintjs';
import { agentComponentsScopeFactory, type AgentComponentsScope } from './scope.ts';
import { runComponentStage, type ComponentChartStages } from './stages.ts';

/** Native mounted subflow: the inner lifecycle retains its own explicitly linked native run. */
export function createAgentComponentSubflow(config: ComponentChartStages, id: string) {
 return flowChart<void, AgentComponentsScope>('Run component lifecycle', runComponentStage(config, id), 'component-lifecycle')
  .setScopeFactory(agentComponentsScopeFactory).build();
}
