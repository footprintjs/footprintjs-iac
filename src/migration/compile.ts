import { identifier,freeze } from '../graph/data.ts';
import { MIGRATION_PHASES,type MigrationRegistry,type MigrationDefinition,type MigrationPlan,type MigrationStrategy } from './types.ts';
import { readMigrationDefinition,readMigrationPlan } from './data.ts';
export function offlineTransferStrategy(id='offline-transfer'):MigrationStrategy{return Object.freeze({id,label:'Fenced offline transfer',plan:()=>({steps:MIGRATION_PHASES.map(phase=>({id:phase,phase,operation:phase}))})});}
export function compileMigrationPlan(input:MigrationDefinition,registry:MigrationRegistry):MigrationPlan{
 const definition=readMigrationDefinition(input);for(const values of [registry.strategies,registry.adapters]){if(!Array.isArray(values)||!values.length||values.length>128||new Set(values.map(value=>identifier(value.id,'migration registration'))).size!==values.length)throw Error('Register bounded unique migration capabilities');}
 const strategy=registry.strategies.find(value=>value.id===definition.strategyId),adapter=registry.adapters.find(value=>value.id===definition.adapterId);if(!strategy||typeof strategy.plan!=='function'||!adapter||typeof adapter.observe!=='function'||typeof adapter.execute!=='function')throw Error('Choose registered migration strategy and adapter');
 const plan=readMigrationPlan(strategy.plan(definition));if(!Array.isArray(adapter.capabilities)||adapter.capabilities.length>128||new Set(adapter.capabilities).size!==adapter.capabilities.length)throw Error('Declare bounded migration capabilities');for(const cap of adapter.capabilities)identifier(cap,'migration capability');if(plan.steps.some(step=>!adapter.capabilities.includes(step.operation)))throw Error('Migration adapter does not support every required protected phase');
 if(plan.steps.some(step=>['gate-revalidation','recovery-revalidation','recover-source','verify-recovery','resume-source'].includes(step.id)))throw Error('Migration step conflicts with a protected continuation');
 adapter.admit?.(definition,plan);return freeze(plan);
}
