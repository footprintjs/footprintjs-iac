import { join, resolve } from 'node:path';
import { ReleasePreparationWorkflow } from '../../../src/releases/preparation.ts';
import { FileReleasePreparationStore } from '../../../src/releases/preparation-store.ts';
import { readReleaseManifest } from '../../../src/releases/manifest.ts';
import { readDeliveryPublication } from '../../../src/delivery/data.ts';
import { identifier } from '../../../src/graph/data.ts';
import { fingerprint } from '../../../src/util.ts';
import { FileStateStore } from '../../../src/store.ts';
import { loadIdentityTarget } from '../target.ts';
import { neoDeliveryBuildAdapters, neoDeliveryRecipe } from '../github-delivery/build.ts';
import { neoDeliveryTarget } from '../github-delivery/target.ts';
import type { NeoPreparedRelease, NeoReleasePreparationOptions } from './types.ts';

/** Build/publish once, without deploying. Explicitly register its sealed output for later environment stages. */
export async function createNeoReleasePreparation(options: NeoReleasePreparationOptions) {
  const targetPath = resolve(options.targetPath), target = await (options.loadTarget??loadIdentityTarget)(targetPath);
  if (targetPath!==join(target.directory,'target.json'))throw Error('Pin the canonical Neo build target');
  const id=identifier(options.id??'neo-release-'+target.id,'Neo release build'),directory=join(target.directory,'release-builds',id),recipe=await neoDeliveryRecipe();
  const adapters=neoDeliveryBuildAdapters({...options,targetPath},target,recipe);
  const workflow=new ReleasePreparationWorkflow({definition:{id,label:'Prepared Neo release',target:neoDeliveryTarget(target),source:options.source,recipe,
    configurationDigest:fingerprint({adapter:'neo-release-build-v1',target:neoDeliveryTarget(target),source:options.source,recipe})},
    store:new FileReleasePreparationStore(directory),adapters:{source:options.sourceAdapter,...adapters},expectedRevision:options.expectedRevision});
  const locks=new FileStateStore(join(target.directory,'delivery-execution-locks'));
  return {target,directory,workflow:{snapshot:workflow.snapshot.bind(workflow),subscribe:workflow.subscribe.bind(workflow),
    start:()=>locks.withLock('github-delivery',()=>workflow.start())},
    async prepared():Promise<NeoPreparedRelease>{
      const state=await workflow.snapshot();if(state.status!=='passed'||!state.release||!state.results.publication)throw Error('Neo release must finish its recorded build and publication');
      return {manifest:readReleaseManifest(state.release),publication:readDeliveryPublication(state.results.publication),buildTargetPath:targetPath};
    }};
}
