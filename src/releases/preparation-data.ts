import { freeze } from '../graph/data.ts';
import { readDeliveryDefinition, readDeliveryState,readSourceRevision } from '../delivery/data.ts';
import { DELIVERY_STAGE_IDS } from '../delivery/types.ts';
import { canonical, fingerprint } from '../util.ts';
import { releaseObject } from './data.ts';
import { defineReleaseManifest, readReleaseManifest } from './manifest.ts';
import { RELEASE_BUILD_STAGES, type ReleasePreparationState } from './preparation-types.ts';

/** Reuse the strict serial delivery event validator without inventing deployment events. */
export function readReleasePreparationState(input: unknown): ReleasePreparationState {
  const row=releaseObject(input,['version','kind','definition','definitionDigest','executionId','status','stages','events','results','recordings','release','error','expectedRevision']);
  if(row.version!==1||row.kind!=='release-preparation'||!Array.isArray(row.stages)||row.stages.length!==4)throw Error('Invalid release preparation');
  const definition=readDeliveryDefinition(row.definition);
  const expectedRevision=row.expectedRevision===undefined?undefined:readSourceRevision(row.expectedRevision);
  if(expectedRevision&&(expectedRevision.repository!==definition.source.repository||expectedRevision.ref!==definition.source.ref))throw Error('Release source selection changed');
  if(row.definitionDigest!==fingerprint(expectedRevision?{definition,expectedRevision}:definition))throw Error('Release preparation definition changed');
  const results=releaseObject(row.results,['revision','source','build','publication']);
  const {release:_,expectedRevision:__,...delivery}=row;
  const projected=readDeliveryState({...delivery,kind:'delivery-state',
    status:row.status==='passed'?'running':row.status,
    stages:[...row.stages,...DELIVERY_STAGE_IDS.slice(4).map(id=>({id,label:id,status:'pending'}))]});
  if(expectedRevision&&projected.results.revision&&canonical(projected.results.revision)!==canonical(expectedRevision))throw Error('Prepared source differs from the reviewed revision');
  if(row.status==='passed'){
    if(!projected.stages.slice(0,4).every(stage=>stage.status==='passed')||!projected.results.publication||row.recordings===undefined
      ||(row.recordings as {status:string}[]).length!==1||(row.recordings as {status:string}[])[0]!.status!=='passed')throw Error('Incomplete release preparation');
    const release=readReleaseManifest(row.release);
    const expected=defineReleaseManifest({id:definition.id,label:definition.label,source:projected.results.revision!,recipe:definition.recipe,artifacts:projected.results.publication.artifacts});
    if(canonical(release)!==canonical(expected))throw Error('Prepared release differs from source or artifacts');
  }else if(row.release!==undefined)throw Error('Only a completed preparation has a sealed release');
  if((row.stages as {id:string}[]).some((stage,i)=>stage.id!==RELEASE_BUILD_STAGES[i]))throw Error('Invalid release stages');
  return freeze({...row,definition,results} as unknown as ReleasePreparationState);
}
