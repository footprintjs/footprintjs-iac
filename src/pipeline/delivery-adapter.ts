import { identifier } from '../graph/data.ts';
import { readReleaseManifest } from '../releases/manifest.ts';
import { canonical } from '../util.ts';
import { readDeliveryDeployment,readDeliveryPlan,readDeliveryPublication,readDeliveryVerification } from '../delivery/data.ts';
import type { DeliveryPublication,DeploymentAdapter } from '../delivery/types.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import { jsonObject } from './data.ts';
import {combineWorkflowEvidenceReferences,DeploymentPreflightRefused} from '../delivery/evidence.ts';
import type { ReleaseObservation,RolloutAdapter,RolloutContext } from './types.ts';

export interface DeploymentRolloutAdapterOptions {
  id:string;label:string;deployment:DeploymentAdapter;
  /** Read the real target revision/artifacts. Never return the request's desired digest without measuring it. */
  observeRelease(context:RolloutContext):Promise<ReleaseObservation>;
  /** Trusted host handle lookup; private publication metadata never enters the release or native summary. */
  publicationForRelease?(release:ReleaseManifest):Promise<DeliveryPublication>|DeliveryPublication;
  /** Explicit host assertion: restoration supports application artifacts only, with independent data compatibility review. */
  restore?:'application-only';
}
/** Bridges the existing selective plan/deploy/verify engine without changing that engine. */
export function deploymentRolloutAdapter(options:DeploymentRolloutAdapterOptions):RolloutAdapter {
  identifier(options.id,'deployment rollout adapter');
  if(!options.label?.trim()||options.label.length>160||typeof options.deployment?.plan!=='function'||typeof options.deployment?.deploy!=='function'||typeof options.deployment?.verify!=='function'||typeof options.observeRelease!=='function'
    ||options.restore!==undefined&&options.restore!=='application-only')throw Error('Configure a deployment rollout adapter with an explicit application-only recovery policy');
  const publication=async(release:ReleaseManifest)=>{
    const result=readDeliveryPublication(await options.publicationForRelease?.(release)??{artifacts:release.artifacts});
    const identity=(items:readonly {id:string;digest:string}[])=>items.map(({id,digest})=>({id,digest})).sort((a,b)=>a.id.localeCompare(b.id));
    if(canonical(identity(result.artifacts))!==canonical(identity(release.artifacts)))throw Error('Host publication differs from the sealed release artifacts');
    return result;
  };
  const adapter:RolloutAdapter={id:options.id,label:options.label,capabilities:Object.freeze(options.restore?['deploy','restore']:['deploy']),
    observe:options.observeRelease,
    async execute(action,release,context){
      release=readReleaseManifest(release);
      if(action.operation!=='deploy'&&!(action.operation==='restore'&&options.restore==='application-only'))throw Error('Unsupported deployment bridge operation');
      let plan;
      try{plan=readDeliveryPlan(await options.deployment.plan(await publication(release),context));}
      catch(error){return {status:'failed' as const,...(error instanceof DeploymentPreflightRefused&&error.evidence.length?{evidence:error.evidence}:{})};}
      let deployment;
      try{deployment=readDeliveryDeployment(await options.deployment.deploy(plan,context));}
      catch(error){if(error instanceof DeploymentPreflightRefused){const evidence=combineWorkflowEvidenceReferences(plan.evidence,error.evidence);return{status:'failed' as const,changes:plan.changes,...(evidence.length?{evidence}:{})};}throw error;}
      const evidence=combineWorkflowEvidenceReferences(plan.evidence,deployment.evidence),references=evidence.length?{evidence}:{};
      if(!deployment.ok)return {status:'failed' as const,changes:plan.changes,...references,metadata:jsonObject({deployment})};
      const verification=readDeliveryVerification(await options.deployment.verify(deployment,context));
      return {status:verification.ok?'succeeded' as const:'failed' as const,changes:plan.changes,...references,metadata:jsonObject({deployment,verification})};
    }};return Object.freeze(adapter);
}
