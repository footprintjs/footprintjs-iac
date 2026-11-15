import { flowChart } from 'footprintjs';
import { migrationScopeFactory,type MigrationScope } from './scope.ts';
import { finishMigration,initializeMigration,migrationOperation,runDecision,skippedMigration,type MigrationStages } from './stages.ts';
/** The sole construction point for the real, fenced pre-cutover lifecycle. */
export function createMigrationPrepareChart(config:MigrationStages){
 const chart=flowChart<void,MigrationScope>('Inspect migration binding',initializeMigration(config),'binding').setScopeFactory(migrationScopeFactory);
 for(const [index,step]of config.plan.steps.slice(0,6).entries())chart.addDeciderFunction('Run '+step.phase+'?',runDecision(config,'run-'+index,'skip-'+index),'route-'+index).addFunctionBranch('run-'+index,step.phase,migrationOperation(config,step)).addFunctionBranch('skip-'+index,'Retain skipped stage',skippedMigration(config,step.id)).end();
 return chart.addFunction('Record cutover gate or failure',finishMigration(config),'outcome').build();
}
