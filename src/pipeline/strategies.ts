import { readRolloutPlan } from './data.ts';
import type { RolloutStrategy } from './types.ts';

export function directStrategy(id = 'direct'): RolloutStrategy {
  const strategy:RolloutStrategy={id,label:'Direct deployment',plan:()=>({steps:[{kind:'action',id:'deploy',operation:'deploy'}]})};return Object.freeze(strategy);
}
export function canaryStrategy(id = 'canary'): RolloutStrategy {
  const strategy:RolloutStrategy={id,label:'Progressive canary',plan:({stage})=>{
    const parameters = stage.parameters ?? {};
    if (Object.keys(parameters).some(key => key !== 'weights')) throw Error('Canary accepts only weights');
    const weights = parameters.weights ?? [5,25,50,100];
    if (!Array.isArray(weights) || !weights.length || weights.length > 16 || weights.at(-1) !== 100
      || weights.some((weight,index) => typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 100 || index > 0 && weight <= Number(weights[index - 1]))) throw Error('Canary weights must increase to 100');
    return readRolloutPlan({ steps: [
      {kind:'action',id:'candidate',operation:'deploy-candidate'},
      ...weights.flatMap(weight => [{kind:'action',id:'traffic-' + weight,operation:'set-traffic',parameters:{weight}}, {kind:'check',id:'analysis-' + weight}]),
      {kind:'action',id:'promote',operation:'promote-candidate'},
    ] });
  }};return Object.freeze(strategy);
}
export function blueGreenStrategy(id = 'blue-green'): RolloutStrategy {
  return Object.freeze({ id, label: 'Blue green', plan: () => readRolloutPlan({steps:[
    {kind:'action',id:'prepare',operation:'prepare-environment'}, {kind:'check',id:'preview-check'},
    {kind:'action',id:'switch',operation:'switch-traffic'}, {kind:'check',id:'live-check'},
    {kind:'action',id:'promote',operation:'promote-environment'},
  ]}) });
}
