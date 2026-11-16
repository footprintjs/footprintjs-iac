import { identifier } from '../graph/data.ts';
import { fingerprint, canonical } from '../util.ts';
import { checkStatus, readCheckResult, readCheckSuite } from '../checks/data.ts';
import type { CheckRequest, CheckRunner } from '../checks/types.ts';
import type { DeploymentCheckBinding } from '../deployment-strategy/types.ts';
/** Compose host-owned suites once, then reuse the exact binding in CLI, Lens and deployment checks. */
export function combineOnboardingCheckBindings(input:{id:string;suiteId:string;label:string;bindings:readonly DeploymentCheckBinding[]}):DeploymentCheckBinding {
 const id=identifier(input.id,'onboarding check runner'),suiteId=identifier(input.suiteId,'onboarding check suite');
 if(!Array.isArray(input.bindings)||!input.bindings.length||input.bindings.length>16)throw Error('Register bounded onboarding check bindings');
 const bindings=(input.bindings as readonly DeploymentCheckBinding[]).map(binding=>{if(typeof binding.runner?.run!=='function')throw Error('Register onboarding check runner');identifier(binding.runner.id,'check runner');const suite=binding.runner.suites().find(row=>row.id===binding.suiteId);if(!suite||!binding.requiredCheckIds.length)throw Error('Register onboarding check suite');const requiredCheckIds=binding.requiredCheckIds.map(value=>identifier(value,'required onboarding check'));return{runner:binding.runner,suite:readCheckSuite(suite),requiredCheckIds};});
 const requiredCheckIds=bindings.flatMap(value=>value.requiredCheckIds);if(new Set(requiredCheckIds).size!==requiredCheckIds.length)throw Error('Overlapping onboarding required checks');
 const contract=()=>bindings.map(binding=>({runnerId:binding.runner.id,suite:readCheckSuite(binding.runner.suites().find(row=>row.id===binding.suite.id)),requiredCheckIds:binding.requiredCheckIds}));
 const captured=contract(),suite=readCheckSuite({id:suiteId,label:input.label,kind:'onboarding-checks',digest:fingerprint(captured)});
 const runner:CheckRunner={id,suites:()=>[suite],async run(request:CheckRequest){
   if(request.suiteId!==suiteId||request.suiteDigest!==suite.digest||canonical(contract())!==canonical(captured))throw Error('Onboarding check contract changed');
   const checks=[] as Awaited<ReturnType<CheckRunner['run']>>['checks'];
   for(const [index,binding]of bindings.entries()){
    const childRequest={...request,invocationId:identifier(`part.${fingerprint({invocationId:request.invocationId,index})}`,'onboarding child check'),suiteId:binding.suite.id,suiteDigest:binding.suite.digest};
    const result=readCheckResult(await binding.runner.run(childRequest));if(canonical(result.request)!==canonical(childRequest))throw Error('Onboarding check request differs');
    for(const check of result.checks){if(checks.some(previous=>previous.id===check.id))throw Error('Overlapping onboarding check observations');checks.push(check);}
    for(const required of binding.requiredCheckIds)if(!result.checks.some(check=>check.id===required))checks.push({id:required,status:'inconclusive'});
   }
   if(canonical(contract())!==canonical(captured))throw Error('Onboarding check contract changed');
   return readCheckResult({request,status:checkStatus(checks),checks});
 }};
 return Object.freeze({runner:Object.freeze(runner),suiteId,requiredCheckIds:Object.freeze(requiredCheckIds)});
}
