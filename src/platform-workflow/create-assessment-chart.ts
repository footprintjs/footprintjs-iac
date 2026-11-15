import { flowChart } from 'footprintjs';
import { platformScopeFactory, type PlatformScope } from './scope.ts';
import { assessPlatformStage, bindPlatformStage, discoverPlatformStage, type PlatformStages } from './stages.ts';

/** Declaration of the recorded host-discovery and bootstrap-assessment subflow. */
export function createPlatformAssessmentChart(config: PlatformStages) {
  return flowChart<void, PlatformScope>('Bind platform intent', bindPlatformStage(config), 'bind')
    .setScopeFactory(platformScopeFactory)
    .addFunction('Discover measured hosts', discoverPlatformStage(config), 'discover')
    .addFunction('Assess bootstrap strategy', assessPlatformStage(config), 'assess').build();
}
