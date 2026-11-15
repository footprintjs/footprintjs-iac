import { join } from 'node:path';
import { canonical } from '../../../src/util.ts';
import { deploymentRolloutAdapter } from '../../../src/pipeline/delivery-adapter.ts';
import type { DeliveryPlan, DeploymentAdapter } from '../../../src/delivery/types.ts';
import type { ReleaseManifest } from '../../../src/releases/types.ts';
import { identityEngine } from '../engine.ts';
import { command } from '../command.ts';
import { loadIdentityTarget, type IdentityTarget } from '../target.ts';
import { loadIdentityNeoImages } from '../load-neo-images.ts';
import { prepareNeoDeliveryMaster } from '../github-delivery/baseline.ts';
import { neoDeliveryDeploymentAdapter } from '../github-delivery/deployment.ts';
import { neoDeliveryTarget } from '../github-delivery/target.ts';
import type { NeoDeliveryObservation } from '../github-delivery/types.ts';
import { bindNeoReleaseCandidate } from './candidate.ts';
import { observeNeoRelease } from './observe.ts';
import type { NeoPreparedRelease, NeoReleaseEnvironment, NeoReleasePipelineOptions } from './types.ts';

export function neoReleaseRolloutAdapter(options: NeoReleasePipelineOptions, environment: NeoReleaseEnvironment,
  directory:string, releases:readonly NeoPreparedRelease[], emit:(event:NeoDeliveryObservation)=>void) {
  const manifests=releases.map(item=>item.manifest),load=options.loadTarget??loadIdentityTarget,run=options.runner??command;
  const operations=new Map<string,{adapter:DeploymentAdapter;release:ReleaseManifest;plan:DeliveryPlan;current:IdentityTarget}>();
  const deployment:DeploymentAdapter={
    async plan(publication,context){
      const selected=releases.find(item=>item.manifest.digest===publication.metadata?.releaseDigest);
      if(!selected)throw Error('Choose a registered Neo manifest');
      const current=await load(environment.targetPath);
      if(canonical(neoDeliveryTarget(current))!==canonical(context.target))throw Error('Neo release environment changed');
      const buildTarget=await load(selected.buildTargetPath??options.environments[0]!.targetPath);
      const bound=await bindNeoReleaseCandidate(selected,buildTarget,current,context.operationId,run);
      await loadIdentityNeoImages(current,bound.candidate.receipt.imageId,bound.candidate.receipt.pythonImageId,
        {fixtureRoot:options.fixtureRoot,loadTarget:load,runner:run});
      const master=await prepareNeoDeliveryMaster(current,selected.manifest.source.repository,(options.engineFactory??identityEngine)(current),emit);
      const adapter=neoDeliveryDeploymentAdapter({targetPath:environment.targetPath,source:{repository:selected.manifest.source.repository,ref:selected.manifest.source.ref},
        sourceAdapter:{async resolve(){throw Error('A sealed release does not resolve source during promotion');},async fetch(){throw Error('A sealed release does not fetch source during promotion');}},
        checks:options.checks,restoreForward:options.restoreForward,assessmentTransport:options.assessmentTransport},current,join(directory,'deployment',environment.id,context.operationId),master.workflow,emit);
      const plan=await adapter.plan(bound.publication,context);
      operations.set(context.operationId,{adapter,release:selected.manifest,plan,current});return plan;
    },
    async deploy(plan,context){
      const operation=operations.get(context.operationId);if(!operation||canonical(operation.plan)!==canonical(plan))throw Error('Neo operation plan is not bound');
      return operation.adapter.deploy(plan,context);
    },
    async verify(receipt,context){
      const operation=operations.get(context.operationId);if(!operation||!receipt.ok)throw Error('Verify a proven Neo artifact deployment');
      const actual=await observeNeoRelease(await load(environment.targetPath),manifests,run);
      const ok=actual.known&&actual.releaseDigest===operation.release.digest;
      return {ok,checks:[{id:'actual-artifact-identity',passed:ok}]};
    },
  };
  return deploymentRolloutAdapter({id:'neo-direct-'+environment.id,label:'Neo selective direct deployment',deployment,
    publicationForRelease(release){const selected=releases.find(item=>item.manifest.digest===release.digest);if(!selected)throw Error('Unknown prepared Neo release');
      return {...selected.publication,metadata:{...selected.publication.metadata,releaseDigest:release.digest}};},
    async observeRelease(context){
      const target=await load(environment.targetPath);if(canonical(context.target)!==canonical(neoDeliveryTarget(target)))return {known:false,releaseDigest:null};
      return observeNeoRelease(target,manifests,run);
    }});
}
