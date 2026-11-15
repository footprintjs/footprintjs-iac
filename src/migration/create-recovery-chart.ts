import { flowChart } from 'footprintjs';
import { migrationScopeFactory,type MigrationScope } from './scope.ts';
import { finishMigration,initializeMigration,migrationOperation,revalidateMigration,runDecision,skippedMigration,type MigrationStages } from './stages.ts';
export function createMigrationRecoveryChart(config:MigrationStages){
 const chart=flowChart<void,MigrationScope>('Bind manual recovery',initializeMigration(config),'binding').setScopeFactory(migrationScopeFactory).addFunction('Revalidate recovery safety',revalidateMigration(config,true),'revalidate');
 const phases:('recover-source'|'verify-recovery'|'resume-source')[]=config.state.checkpoint.switched?['recover-source','verify-recovery','resume-source']:['verify-recovery','resume-source'];
 for(const[index,phase]of phases.entries())chart.addDeciderFunction('Run '+phase+'?',runDecision(config,'run-'+index,'skip-'+index),'route-'+index).addFunctionBranch('run-'+index,phase,migrationOperation(config,{id:phase,phase,operation:phase})).addFunctionBranch('skip-'+index,'Retain blocked recovery',skippedMigration(config,phase)).end();
 return chart.addFunction('Record recovery result',finishMigration(config),'outcome').build();
}
