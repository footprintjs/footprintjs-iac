import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentRolloutAdapter } from '../src/pipeline/node.ts';
import { defineReleaseManifest } from '../src/releases/node.ts';
import type { DeploymentAdapter } from '../src/delivery/types.ts';

const release=defineReleaseManifest({id:'app-v2',source:{repository:'https://github.com/example/app',ref:'v2',commit:'a'.repeat(40),tree:'b'.repeat(40)},recipe:{id:'images',digest:'c'.repeat(64)},artifacts:[{id:'app',digest:'d'.repeat(64),reference:'registry/app:v2'}]});
const context={executionId:'attempt',operationId:'operation',definitionDigest:'e'.repeat(64),stageId:'gamma',target:{id:'gamma',scope:'cluster/gamma'}};
function adapter(){
  const calls:string[]=[];
  const deployment:DeploymentAdapter={async plan(publication){calls.push('plan');assert.equal(publication.metadata?.candidatePath,'/private/host/candidate');return {id:'review',digest:'f'.repeat(64),changes:[{resourceId:'api',action:'update'},{resourceId:'database',action:'noop'}]};},
    async deploy(){calls.push('deploy');return {ok:true,runId:'provider-native',metadata:{private:'provider-handle'}};},
    async verify(){calls.push('verify');return {ok:true,checks:[{id:'measured',passed:true}]};}};
  return {calls,deployment};
}
test('existing engine bridge retains selective resource plan and host-private publication while requiring actual release observation',async()=>{
  const f=adapter(),bridge=deploymentRolloutAdapter({id:'engine',label:'Existing engine',deployment:f.deployment,
    publicationForRelease:()=>({artifacts:[...release.artifacts],metadata:{candidatePath:'/private/host/candidate'}}),observeRelease:async()=>({known:true,releaseDigest:release.digest})});
  assert.deepEqual(bridge.capabilities,['deploy']);
  const result=await bridge.execute({kind:'action',id:'apply',operation:'deploy'},release,context);
  assert.equal(result.status,'succeeded');assert.deepEqual(f.calls,['plan','deploy','verify']);assert.deepEqual(result.changes,[{resourceId:'api',action:'update'},{resourceId:'database',action:'noop'}]);
  assert.deepEqual(await bridge.observe(context),{known:true,releaseDigest:release.digest});
  await assert.rejects(()=>bridge.execute({kind:'action',id:'restore',operation:'restore'},release,context),/Unsupported/);
});
test('publication mismatch is rejected before planning or deployment, restoration is an explicit host application-only capability',async()=>{
  const f=adapter(),bridge=deploymentRolloutAdapter({id:'engine',label:'Existing engine',deployment:f.deployment,restore:'application-only',
    publicationForRelease:()=>({artifacts:[{...release.artifacts[0]!,digest:'0'.repeat(64)}]}),observeRelease:async()=>({known:false,releaseDigest:null})});
  assert.deepEqual(bridge.capabilities,['deploy','restore']);assert.equal((await bridge.execute({kind:'action',id:'apply',operation:'deploy'},release,context)).status,'failed');assert.deepEqual(f.calls,[]);
  assert.deepEqual(await bridge.observe(context),{known:false,releaseDigest:null});
});
