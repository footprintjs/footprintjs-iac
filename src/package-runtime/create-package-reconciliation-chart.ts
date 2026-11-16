import {flowChart} from 'footprintjs';
import {PackageScope,packageScopeFactory} from './scope.ts';
import {inspectPackageReconciliation,observePackageReconciliation,classifyPackageReconciliation,packageReconciliationStage,type PackageReconciliationConfiguration} from './reconciliation-stages.ts';
/** Read-only observation of one acknowledged prior activation. No installation or runtime control stage exists. */
export function createPackageReconciliationChart(config:PackageReconciliationConfiguration){return flowChart<void,PackageScope>('Inspect owned activation',packageReconciliationStage('inspect',inspectPackageReconciliation(config)),'inspect').setScopeFactory(packageScopeFactory)
 .addFunction('Observe actual runtime',packageReconciliationStage('observe',observePackageReconciliation(config)),'observe').addFunction('Classify measured outcome',packageReconciliationStage('classify',classifyPackageReconciliation(config)),'classify').build();}
