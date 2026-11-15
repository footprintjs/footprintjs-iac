import {flowChart} from 'footprintjs';
import {deliveryScopeFactory,type DeliveryScope} from '../delivery/scope.ts';
import {resolveSourceStage,fetchSourceStage,buildSourceStage,publishArtifactsStage,type SourceBuildStages} from '../delivery/stages.ts';

/** Source preparation stops at actual artifact publication. Review and deployment are separate workflows. */
export function createSourcePreparationChart(config:SourceBuildStages){
 return flowChart<void,DeliveryScope>('Choose exact version',resolveSourceStage(config),'resolve')
  .setScopeFactory(deliveryScopeFactory)
  .addFunction('Get code',fetchSourceStage(config),'fetch')
  .addFunction('Build package',buildSourceStage(config),'build')
  .addFunction('Store package',publishArtifactsStage(config),'publish').build();
}
