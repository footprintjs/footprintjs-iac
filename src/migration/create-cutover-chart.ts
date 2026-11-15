import { flowChart } from 'footprintjs';
import { migrationScopeFactory,type MigrationScope } from './scope.ts';
import { finishMigration,initializeMigration,migrationOperation,revalidateMigration,runDecision,skippedMigration,type MigrationStages } from './stages.ts';
export function createMigrationCutoverChart(config:MigrationStages){
 const chart=flowChart<void,MigrationScope>('Bind continuation',initializeMigration(config),'binding').setScopeFactory(migrationScopeFactory).addFunction('Revalidate source, fence, backup and replacement',revalidateMigration(config),'revalidate');
 for(const[index,step]of config.plan.steps.slice(6).entries())chart.addDeciderFunction('Run '+step.phase+'?',runDecision(config,'run-'+index,'skip-'+index),'route-'+index).addFunctionBranch('run-'+index,step.phase,migrationOperation(config,step)).addFunctionBranch('skip-'+index,'Retain skipped stage',skippedMigration(config,step.id)).end();
 return chart.addFunction('Record active system and retained source',finishMigration(config),'outcome').build();
}
