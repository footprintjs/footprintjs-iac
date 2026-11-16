import {flowChart} from 'footprintjs';
import {deliveryScopeFactory,type DeliveryScope} from '../delivery/scope.ts';
import {resolveSourceStage,fetchSourceStage,buildSourceStage,publishArtifactsStage,type SourceBuildStages} from '../delivery/stages.ts';

/** The shared native preparation ends at artifact publication, before review. */
export function createPreparationChart(config:SourceBuildStages){
 return flowChart<void,DeliveryScope>('Choose exact version',resolveSourceStage(config),'resolve')
  .setScopeFactory(deliveryScopeFactory)
  .addFunction('Get code',fetchSourceStage(config),'fetch')
  .addFunction('Build package',buildSourceStage(config),'build')
  .addFunction('Store package',publishArtifactsStage(config),'publish').build();
}
