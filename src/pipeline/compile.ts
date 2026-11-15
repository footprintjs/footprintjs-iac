import { freeze, identifier } from '../graph/data.ts';
import { readCheckCatalog } from '../checks/data.ts';
import { readReleaseManifestShape as readReleaseManifest } from '../releases/data.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import { readPipelineDefinition, readRolloutPlan } from './data.ts';
import type { PipelineDefinition, PipelineRegistry, PipelineStageDefinition, RolloutPlan } from './types.ts';

export interface CompiledRollout { stageId: string; strategyId: string; adapterId: string; plan: RolloutPlan }
function index<T extends {id:string}>(values: readonly T[], name: string): Map<string,T> {
  if (!Array.isArray(values) || values.length > 128) throw Error('Configure a bounded ' + name + ' registry');
  const result = new Map<string,T>();
  for (const value of values) { const id = identifier(value.id,name); if (result.has(id)) throw Error('Duplicate ' + name); result.set(id,value); }
  return result;
}
function admitOperationIds(stage:PipelineStageDefinition,plan:RolloutPlan):void {
  const ids=new Set<string>();
  const add=(id:string)=>{identifier(id,'expanded pipeline operation');if(ids.has(id))throw Error('Rollout step conflicts with an implicit pipeline operation');ids.add(id);};
  add('before');add('after');
  for(const step of plan.steps) {
    if(step.kind==='action')add(step.id);
    else stage.checks.forEach((_,index)=>add(step.id+'-'+index));
  }
  stage.checks.forEach((_,index)=>add('acceptance-'+index));
  if(stage.rollback!=='disabled') {
    add('recovery-before');add('recovery-after');add('recovery-restore');
    stage.checks.forEach((_,index)=>add('recovery-acceptance-'+index));
  }
}
/** Pure host-side admission of the entire pipeline. No adapter effects occur here. */
export function compileRolloutPlans(input: PipelineDefinition, releaseInput: ReleaseManifest, registry: PipelineRegistry): readonly CompiledRollout[] {
  const definition = readPipelineDefinition(input), release = readReleaseManifest(releaseInput);
  const strategies = index(registry.strategies,'strategy'), adapters = index(registry.adapters,'rollout adapter'), checks = index(registry.checks,'check runner');
  let operationBudget = 0;
  return freeze(definition.stages.map(stage => {
    const strategy = strategies.get(stage.strategyId), adapter = adapters.get(stage.adapterId);
    if (!strategy || typeof strategy.plan !== 'function' || !adapter || typeof adapter.execute !== 'function' || typeof adapter.observe !== 'function') throw Error('Register every selected strategy and rollout adapter');
    const plan = readRolloutPlan(strategy.plan({stage,release}));admitOperationIds(stage,plan);
    const operations = 2 + plan.steps.reduce((count,step) => count + (step.kind === 'check' ? stage.checks.length : 1),0) + stage.checks.length
      + (stage.rollback === 'disabled' ? 0 : 3 + stage.checks.length);
    operationBudget += operations;
    if (operations > 512 || operationBudget > 2048) throw Error('Pipeline operation plan exceeds recording limits');
    const capabilities = adapter.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > 128 || new Set(capabilities).size !== capabilities.length) throw Error('Declare bounded adapter capabilities');
    for (const operation of capabilities) identifier(operation,'adapter capability');
    const needed = plan.steps.flatMap(step => step.kind === 'action' ? [step.operation] : []);
    if (stage.rollback !== 'disabled') needed.push('restore');
    if (needed.some(operation => !capabilities.includes(operation))) throw Error('Rollout adapter does not support the selected strategy or recovery policy');
    for (const check of stage.checks) {
      const runner = checks.get(check.runnerId);
      if (!runner || typeof runner.suites !== 'function' || typeof runner.run !== 'function'
        || !readCheckCatalog(runner.suites()).some(suite => suite.id === check.suiteId && suite.digest === check.suiteDigest)) throw Error('Acceptance suite identity is not registered');
    }
    adapter.admit?.({stage,release,plan});
    return {stageId:stage.id,strategyId:stage.strategyId,adapterId:stage.adapterId,plan};
  }));
}
