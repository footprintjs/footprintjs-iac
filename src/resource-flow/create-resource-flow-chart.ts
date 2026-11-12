import { flowChart } from 'footprintjs';
import { resourceFlowScopeFactory, type ResourceFlowScope } from './scope.ts';
import { acquireResourceStage, connectResourceStage, resolveDetailsStage, verifyResourceStage, type ResourceFlowStages } from './stages.ts';

/** The sole construction point for the actual serial resource lifecycle chart. */
export function createResourceFlowChart(config: ResourceFlowStages) {
  return flowChart<void, ResourceFlowScope>(config.definition.mode === 'create' ? 'Create resource' : 'Find existing resource', acquireResourceStage(config), 'acquire')
    .setScopeFactory(resourceFlowScopeFactory)
    .addFunction('Connection details', resolveDetailsStage(config), 'details')
    .addFunction('Connect application', connectResourceStage(config), 'connect')
    .addFunction('Verify connection and access', verifyResourceStage(config), 'verify').build();
}
