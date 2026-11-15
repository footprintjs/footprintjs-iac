import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CheckWorkflow } from '../checks/workflow.ts';
import { FileCheckStore } from '../checks/store.ts';
import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { fingerprint } from '../util.ts';
import type { CheckTarget } from '../checks/types.ts';
import type { SystemdHostObservation } from './types.ts';
import type { SystemdResourceAdapter } from './systemd-resource.ts';

/** Records the measured host/unit facts by digest; private host diagnostics never cross this boundary. */
export async function recordSystemdTarget(input:{adapter:SystemdResourceAdapter;bindingDigest:string;directory:string;releaseId:string;releaseDigest:string;target:CheckTarget}) {
  let facts:SystemdHostObservation|undefined;
  const suite={id:'systemd-target',label:'Verify exact systemd host and installed units',kind:'preflight',digest:input.bindingDigest};
  const request={invocationId:randomUUID(),suiteId:suite.id,suiteDigest:suite.digest,releaseId:input.releaseId,releaseDigest:input.releaseDigest,stageId:'systemd-target',target:input.target,reason:'manual' as const};
  const runner={id:suite.id,suites:()=>[suite],async run(current:typeof request){
    try{facts=await input.adapter.inspect();return{request:current,status:'passed' as const,checks:[{id:'machine-identity',status:'passed' as const},{id:'unit-bindings',status:'passed' as const}],
      artifacts:[{id:'systemd-observation',digest:fingerprint(facts),reference:`observations:sha256:${fingerprint(facts)}`}]};}
    catch{return{request:current,status:'failed' as const,checks:[{id:'machine-identity',status:'failed' as const},{id:'unit-bindings',status:'failed' as const}]};}
  }};
  const workflow=new CheckWorkflow({runner,request,store:new FileCheckStore(join(input.directory,'target'))});await workflow.start();const state=await workflow.snapshot();
  if(state.recording?.complete){const evidence=await loadEvidence(state.recording.evidencePath);await verifyEvidenceTrace(evidence);}
  return {state,facts,passed:state.status==='passed'&&state.recording?.complete===true&&facts!==undefined};
}
