import { flowChart } from 'footprintjs';
import { deliveryScopeFactory, type DeliveryScope } from './scope.ts';
import { resolveSourceStage, fetchSourceStage, buildSourceStage, publishArtifactsStage, planDeliveryStage,
  deployDeliveryStage, verifyDeliveryStage, type DeliveryStages } from './stages.ts';

/** Sole construction point: the visible chart is the native execution, not a simulated progress script. */
export function createDeliveryChart(config: DeliveryStages) {
  return flowChart<void, DeliveryScope>('Choose exact version', resolveSourceStage(config), 'resolve')
    .setScopeFactory(deliveryScopeFactory)
    .addFunction('Get code', fetchSourceStage(config), 'fetch')
    .addFunction('Build package', buildSourceStage(config), 'build')
    .addFunction('Store package', publishArtifactsStage(config), 'publish')
    .addFunction('Review changes', planDeliveryStage(config), 'plan')
    .addFunction('Deploy changes', deployDeliveryStage(config), 'deploy')
    .addFunction('Check application', verifyDeliveryStage(config), 'verify').build();
}
