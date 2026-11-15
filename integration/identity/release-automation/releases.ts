import {readReleaseManifest} from '../../../src/releases/manifest.ts';
import {readDeliveryPublication} from '../../../src/delivery/data.ts';
import {canonical} from '../../../src/util.ts';
import type {ReleaseAutomationState} from '../../../src/release-automation/types.ts';
import type {NeoPreparedRelease} from '../release-pipeline/types.ts';

export function registeredNeoAutomationReleases(baselines:readonly NeoPreparedRelease[],state:ReleaseAutomationState|undefined,buildTargetPath:string):NeoPreparedRelease[]{
  const candidates=[...baselines,...(state?.attempts??[]).filter(attempt=>attempt.preparation?.status==='passed').map(attempt=>({manifest:attempt.preparation!.release!,publication:attempt.preparation!.results.publication!,buildTargetPath}))];
  const result:NeoPreparedRelease[]=[];
  for(const value of candidates){const admitted={manifest:readReleaseManifest(value.manifest),publication:readDeliveryPublication(value.publication),...(value.buildTargetPath?{buildTargetPath:value.buildTargetPath}:{})};
    if(canonical(admitted.manifest.artifacts)!==canonical(admitted.publication.artifacts))throw Error('Neo prepared publication differs from manifest');
    const previous=result.find(item=>item.manifest.id===admitted.manifest.id);if(previous){if(canonical(previous)!==canonical(admitted))throw Error('Neo release registration changed');continue;}
    result.push(admitted);
  }
  return result;
}
