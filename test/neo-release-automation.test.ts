import assert from 'node:assert/strict';
import test from 'node:test';
import {defineReleaseManifest} from '../src/releases/manifest.ts';
import {registeredNeoAutomationReleases} from '../integration/identity/release-automation/releases.ts';
import type {NeoPreparedRelease} from '../integration/identity/release-pipeline/types.ts';
import type {ReleaseAutomationState} from '../src/release-automation/types.ts';

function release(version:number):NeoPreparedRelease{
  const artifacts=['node','python'].map(id=>({id,digest:String(version).repeat(64),reference:'registry/neo-'+id+':v'+version}));
  return{manifest:defineReleaseManifest({id:'neo-'+version,source:{repository:'https://github.com/acme/neo.git',ref:'v'+version,commit:String(version).repeat(40),tree:'a'.repeat(40)},recipe:{id:'neo-images',digest:'b'.repeat(64)},artifacts}),publication:{artifacts,metadata:{candidatePath:'/private/candidate-'+version}},buildTargetPath:'/private/target.json'};
}
test('Neo automation retains a passed build even when its later pipeline failed, so actual candidate identity remains recognizable',()=>{
  const baseline=release(1),candidate=release(2),state={attempts:[{status:'failed',preparation:{status:'passed',release:candidate.manifest,results:{publication:candidate.publication}}}]} as unknown as ReleaseAutomationState;
  const releases=registeredNeoAutomationReleases([baseline],state,'/private/target.json');assert.deepEqual(releases.map(value=>value.manifest.id),['neo-1','neo-2']);assert.deepEqual(releases[1],candidate);
  assert.equal(registeredNeoAutomationReleases([baseline,baseline],undefined,'/private/target.json').length,1);
});
test('Neo automation rejects substituted publication content and conflicting duplicate release registrations',()=>{
  const baseline=release(1),bad=structuredClone(baseline);bad.publication.artifacts[0]!.digest='f'.repeat(64);
  assert.throws(()=>registeredNeoAutomationReleases([bad],undefined,'/private/target.json'),/publication differs/);
  const other=structuredClone(baseline);other.publication.metadata!.candidatePath='/private/substitute';
  assert.throws(()=>registeredNeoAutomationReleases([baseline,other],undefined,'/private/target.json'),/registration changed/);
});
