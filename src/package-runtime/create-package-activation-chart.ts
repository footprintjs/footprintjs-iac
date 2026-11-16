import {flowChart} from 'footprintjs';
import {PackageScope,packageScopeFactory} from './scope.ts';
import {verifyPackageStage,stagePackageStage,activatePackageStage,observePackageStage,type PackageStageConfiguration} from './stages.ts';
/** A child installation flow, not a deployment planner. The existing host owns its review/permit. */
export function createPackageActivationChart(config:PackageStageConfiguration){
 return flowChart<void,PackageScope>('Verify package',verifyPackageStage(config),'verify').setScopeFactory(packageScopeFactory)
  .addFunction('Stage files',stagePackageStage(config),'stage')
  .addFunction('Activate version',activatePackageStage(config),'activate')
  .addFunction('Observe running code',observePackageStage(config),'observe').build();
}
