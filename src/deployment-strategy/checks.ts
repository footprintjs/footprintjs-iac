import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CheckWorkflow } from '../checks/workflow.ts';
import { FileCheckStore } from '../checks/store.ts';
import { checkStatus, readCheckCatalog, readCheckResult } from '../checks/data.ts';
import { identifier } from '../graph/data.ts';
import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { fingerprint } from '../util.ts';
import type { CheckExecutionState, CheckObservation, CheckTarget } from '../checks/types.ts';
import type { DeploymentCheckBinding } from './types.ts';

export function captureCheckBinding(input: DeploymentCheckBinding): DeploymentCheckBinding {
  if (!input || typeof input.runner?.run!=='function' || typeof input.runner?.suites!=='function' || !Array.isArray(input.requiredCheckIds) || !input.requiredCheckIds.length) throw Error('deployment-check-binding-required');
  const catalog=readCheckCatalog(input.runner.suites()), suiteId=identifier(input.suiteId,'deployment suite');
  if (!catalog.some(suite=>suite.id===suiteId)) throw Error('deployment-check-suite-not-registered');
  const ids=[...new Set(input.requiredCheckIds.map(id=>identifier(id,'required deployment check')))];
  const runner=input.runner;
  return {suiteId,requiredCheckIds:ids,runner:{id:runner.id,suites:runner.suites.bind(runner),run:runner.run.bind(runner)}};
}
export const checkContract = (binding: DeploymentCheckBinding) => fingerprint({runnerId:binding.runner.id,suite:readCheckCatalog(binding.runner.suites()).find(item=>item.id===binding.suiteId),required:binding.requiredCheckIds});
export async function runDeploymentChecks(binding: DeploymentCheckBinding, input:{directory:string;stageId:string;releaseId:string;releaseDigest:string;target:CheckTarget}): Promise<CheckExecutionState> {
  const suite=readCheckCatalog(binding.runner.suites()).find(item=>item.id===binding.suiteId);if(!suite)throw Error('deployment-check-suite-not-registered');
  const request={invocationId:randomUUID(),suiteId:suite.id,suiteDigest:suite.digest,releaseId:input.releaseId,releaseDigest:input.releaseDigest,stageId:input.stageId,target:input.target,reason:'manual' as const};
  const runner={id:binding.runner.id,suites:binding.runner.suites.bind(binding.runner),async run(current:typeof request){
    const measured=readCheckResult(await binding.runner.run(current));
    const checks:CheckObservation[]=binding.requiredCheckIds.map(id=>({id,status:measured.checks.find(check=>check.id===id)?.status??'failed'}));
    if(measured.status!=='passed'&&checks.every(check=>check.status==='passed'))checks.push({id:'required-checks',status:'failed'});
    return {request:measured.request,status:checkStatus(checks),checks};
  }};
  const workflow=new CheckWorkflow({runner,request,store:new FileCheckStore(join(input.directory,input.stageId))});await workflow.start();const state=await workflow.snapshot();
  if(state.recording?.complete){const evidence=await loadEvidence(state.recording.evidencePath);await verifyEvidenceTrace(evidence);}
  return state;
}

/** A native failed gate records a changed approved suite without invoking its replacement. */
export function contractCheck(expected:string,observed:string):DeploymentCheckBinding {
  const id='approved-check-contract',suite={id,label:'Verify reviewed deployment check contract',kind:'verification',digest:fingerprint({expected,observed})};
  return {suiteId:id,requiredCheckIds:[id],runner:{id,suites:()=>[suite],async run(request){const passed=expected===observed;return{request,status:passed?'passed':'failed',checks:[{id,status:passed?'passed':'failed'}]};}}};
}

export function applicationContract(binding:DeploymentCheckBinding) {
  const suite=readCheckCatalog(binding.runner.suites()).find(item=>item.id===binding.suiteId);if(!suite)throw Error('deployment-check-suite-not-registered');
  return {runnerId:binding.runner.id,suiteId:suite.id,suiteDigest:suite.digest,requiredCheckIds:[...binding.requiredCheckIds]};
}
