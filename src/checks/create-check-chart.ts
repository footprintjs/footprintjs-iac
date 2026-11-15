import { flowChart } from 'footprintjs';
import { checkScopeFactory, type CheckScope } from './scope.ts';
import { admitCheckStage, runCheckStage, evaluateCheckStage, type CheckStages } from './stages.ts';

/** One finite native flow per check/monitor invocation. There is no timer-driven progress simulation. */
export function createCheckChart(config: CheckStages) {
  return flowChart<void, CheckScope>('Bind release and suite', admitCheckStage(config), 'bind')
    .setScopeFactory(checkScopeFactory)
    .addFunction('Run registered checks', runCheckStage(config), 'check')
    .addFunction('Evaluate measured result', evaluateCheckStage(config), 'evaluate').build();
}
