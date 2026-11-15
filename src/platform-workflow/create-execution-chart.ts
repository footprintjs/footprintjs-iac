import { flowChart } from 'footprintjs';
import { executeActionStage, intendActionStage, refreshActionFactsStage, revalidateActionStage } from './action-stages.ts';
import { findPlatformStage, publishPlatformAccessStage, verifyPlatformAccessStage } from './publication-stages.ts';
import { platformScopeFactory, type PlatformScope } from './scope.ts';
import { bindPlatformStage, type PlatformStages } from './stages.ts';

/** One native stage for each validation, durable intent and actual registered action. */
export function createPlatformExecutionChart(config: PlatformStages) {
  let chart = flowChart<void, PlatformScope>('Bind assessed bootstrap plan', bindPlatformStage(config), 'bind')
    .setScopeFactory(platformScopeFactory);
  for (const action of config.state.plan!.actions) {
    chart = chart.addFunction('Discover before ' + action.id, refreshActionFactsStage(config, action.id), 'refresh-' + action.id)
      .addFunction('Revalidate ' + action.id, revalidateActionStage(config, action.id), 'revalidate-' + action.id)
      .addFunction('Retain intent ' + action.id, intendActionStage(config, action.id), 'intent-' + action.id)
      .addFunction('Execute ' + action.id, executeActionStage(config, action.id), 'execute-' + action.id);
  }
  return chart.addFunction('Find physical cluster', findPlatformStage(config), 'find-cluster')
    .addFunction('Publish Kubernetes access', publishPlatformAccessStage(config), 'publish-access')
    .addFunction('Verify Kubernetes access', verifyPlatformAccessStage(config), 'verify-access').build();
}
