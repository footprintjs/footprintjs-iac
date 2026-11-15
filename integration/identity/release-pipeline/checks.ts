import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '../../../src/util.ts';
import { readCheckRequest, readCheckResult, checkStatus } from '../../../src/checks/data.ts';
import type { CheckRunner, CheckSuite } from '../../../src/checks/types.ts';
import type { ReleaseManifest } from '../../../src/releases/types.ts';
import { createIdentityGraph } from '../graph.ts';
import { neoDeliveryTarget } from '../github-delivery/target.ts';
import type { NeoDeliveryObservation } from '../github-delivery/types.ts';
import { verifyNeoResourceFlow } from '../resource-flow-verify.ts';
import { loadIdentityTarget } from '../target.ts';
import { observeNeoRelease } from './observe.ts';
import type { NeoReleaseEnvironment, NeoReleasePipelineOptions } from './types.ts';

export function neoReleaseCheckRunner(options: NeoReleasePipelineOptions, manifests: readonly ReleaseManifest[], suite: CheckSuite,
  directory: string, emit: (event:NeoDeliveryObservation)=>void): CheckRunner {
  return {id:'neo-live-access',suites:()=>[suite],async run(input) {
    const request = readCheckRequest(input), environment = options.environments.find(environment=>environment.id===request.stageId);
    if (!environment || request.suiteId!==suite.id || request.suiteDigest!==suite.digest) throw Error('Choose the registered Neo acceptance suite');
    const target = await (options.loadTarget??loadIdentityTarget)(environment.targetPath);
    if (canonical(neoDeliveryTarget(target))!==canonical(request.target)) throw Error('Neo acceptance target differs from the stage');
    const actual = await observeNeoRelease(target,manifests,options.runner);
    if (!actual.known || actual.releaseDigest!==request.releaseDigest || !manifests.some(manifest=>manifest.id===request.releaseId&&manifest.digest===request.releaseDigest)) throw Error('Neo acceptance release is not the actual deployed version');
    const graph = createIdentityGraph(target,{includeNeo:true}), checksDirectory = join(directory,'checks',request.invocationId);
    const measured = await verifyNeoResourceFlow(target,checksDirectory,options.checks,{
      connections(snapshot,result){emit({kind:'connections',graph,snapshot,...(result?{result}:{})});},
      identity(snapshot,result){emit({kind:'identity',graph,snapshot,...(result?{result}:{})});},
    });
    const checks = measured.checks.map((check,index)=>({id:index<3?'connection-'+index:check.id,status:check.passed?'passed' as const:'failed' as const}));
    const artifacts = await Promise.all((measured.receipts??[]).map(async receipt=>{
      if (!receipt.runId || !receipt.evidencePath) throw Error('Neo native check receipt is incomplete');
      return {id:receipt.id,digest:createHash('sha256').update(await readFile(receipt.evidencePath)).digest('hex'),reference:'footprint-run:'+receipt.runId};
    }));
    if(checks.length!==10||artifacts.length!==2)throw Error('Neo acceptance requires three connections and seven access checks');
    return readCheckResult({request,status:checkStatus(checks),checks,artifacts});
  }};
}
