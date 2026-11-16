import {flowChart} from 'footprintjs';
import {PackageScope,packageScopeFactory} from './scope.ts';
import {settlePackageReconciliation,packageReconciliationStage,type PackageReconciliationConfiguration} from './reconciliation-stages.ts';
/** Only closes the exact target-owned pending journal after admitted observation proof. */
export function createPackageSettlementChart(config:PackageReconciliationConfiguration){return flowChart<void,PackageScope>('Settle acknowledged activation',packageReconciliationStage('settle',settlePackageReconciliation(config)),'settle').setScopeFactory(packageScopeFactory).build();}
