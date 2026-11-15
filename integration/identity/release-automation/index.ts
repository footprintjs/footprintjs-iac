import {join,resolve} from 'node:path';
import {identifier} from '../../../src/graph/data.ts';
import {canonical,fingerprint} from '../../../src/util.ts';
import {releaseDigest} from '../../../src/releases/data.ts';
import {ReleaseAutomationHost} from '../../../src/release-automation/workflow.ts';
import {FileReleaseAutomationStore} from '../../../src/release-automation/store.ts';
import type {ReleaseAutomationAdapter} from '../../../src/release-automation/types.ts';
import {createNeoReleasePipeline} from '../release-pipeline/index.ts';
import {createNeoReleasePreparation} from '../release-pipeline/preparation.ts';
import {neoDeliveryRecipe} from '../github-delivery/build.ts';
import {neoDeliveryTarget} from '../github-delivery/target.ts';
import type {NeoDeliveryObservation} from '../github-delivery/types.ts';
import {loadIdentityTarget} from '../target.ts';
import {registeredNeoAutomationReleases} from './releases.ts';
import type {NeoReleaseAutomationOptions} from './types.ts';

export * from './types.ts';
export {registeredNeoAutomationReleases} from './releases.ts';

/** Neo is a consumer of generic catalog/build/automation/pipeline ports. No Actions/CI is started. */
export async function createNeoReleaseAutomation(input:NeoReleaseAutomationOptions){
  const id=identifier(input.id,'Neo release automation'),directory=resolve(input.directory);releaseDigest(input.configurationDigest);
  if(!input.environments.length||typeof input.sourceAdapter!=='function')throw Error('Register Neo environments and source adapter factory');
  const environments=input.environments.map(environment=>({...environment,targetPath:resolve(environment.targetPath)}));
  const load=input.loadTarget??loadIdentityTarget,targets=await Promise.all(environments.map(environment=>load(environment.targetPath)));
  for(const [index,target] of targets.entries())if(environments[index]!.targetPath!==join(target.directory,'target.json'))throw Error('Pin canonical Neo environment targets');
  const buildTargetPath=environments[0]!.targetPath,recipe=await neoDeliveryRecipe(),store=new FileReleaseAutomationStore(join(directory,'automation'));
  const configurationDigest=fingerprint({version:1,host:input.configurationDigest,recipe,environments:environments.map((environment,index)=>({id:environment.id,label:environment.label,target:neoDeliveryTarget(targets[index]!),targetPath:environment.targetPath,promotion:environment.promotion,rollback:environment.rollback})),baselines:input.baselineReleases.map(item=>({manifest:item.manifest,buildTargetPath:item.buildTargetPath?resolve(item.buildTargetPath):buildTargetPath})),automatic:input.automatic});
  const listeners=new Set<(event:NeoDeliveryObservation)=>void>(),emit=(event:NeoDeliveryObservation)=>{for(const listener of listeners)try{listener(event);}catch{/* Observers cannot change provider execution. */}};
  const pipelineOptions={environments,checks:input.checks,runner:input.runner,loadTarget:input.loadTarget,fixtureRoot:input.fixtureRoot,restoreForward:input.restoreForward,engineFactory:input.engineFactory,assessmentTransport:input.assessmentTransport};
  const retained=await store.load(),initialReleases=registeredNeoAutomationReleases(input.baselineReleases,retained,buildTargetPath);
  const consumers=new Map<string,Awaited<ReturnType<typeof createNeoReleasePipeline>>>();
  const workflows=new Map<string,Awaited<ReturnType<Awaited<ReturnType<typeof createNeoReleasePipeline>>['createPipeline']>>['workflow']>();
  const adapter:ReleaseAutomationAdapter={id:'neo-source-build-pipeline',async prepare(choice,context){
    const sourceAdapter=await input.sourceAdapter(choice,context),build=await createNeoReleasePreparation({id:'auto-'+fingerprint({host:id,attempt:context.attemptId}).slice(0,48),targetPath:buildTargetPath,source:{repository:choice.source.repository,ref:choice.source.ref},sourceAdapter,expectedRevision:choice.source,
      loadTarget:input.loadTarget,buildImages:input.buildImages,buildOptions:input.buildOptions});
    return build.workflow;
  },async pipeline(prepared,context){
    const existing=workflows.get(context.attemptId);if(existing)return existing;
    if(!prepared.release||!prepared.results.publication||prepared.status!=='passed')throw Error('Choose a passed Neo preparation');
    const current=await store.load(),releases=registeredNeoAutomationReleases(input.baselineReleases,current,buildTargetPath);
    if(!releases.some(item=>item.manifest.digest===prepared.release!.digest))releases.push({manifest:prepared.release,publication:prepared.results.publication,buildTargetPath});
    const consumer=await createNeoReleasePipeline({...pipelineOptions,id:'auto-'+fingerprint(id).slice(0,24),directory:join(directory,'pipelines'),releases});
    consumer.subscribe(emit);const built=await consumer.createPipeline({id:context.attemptId,releaseId:prepared.release.id});
    consumers.set(context.attemptId,consumer);workflows.set(context.attemptId,built.workflow);return built.workflow;
  }};
  const host=new ReleaseAutomationHost({definition:{version:1,id,label:input.label??'Neo software updates',catalogId:input.catalog.id,adapterId:adapter.id,configurationDigest,automatic:input.automatic},catalog:input.catalog,adapter,store});
  // Validate immutable host settings and retained native receipts before offering controls.
  await host.snapshot();
  // Admission reconstructs existing baselines; it does not start a release deployment.
  const initialConsumer=await createNeoReleasePipeline({...pipelineOptions,id:'auto-'+fingerprint(id).slice(0,24),directory:join(directory,'pipelines'),releases:initialReleases});
  return{host,store,directory,initialConsumer,
    async consumer(attemptId:string){identifier(attemptId,'Neo automation attempt');return consumers.get(attemptId);},
    subscribe(listener:(event:NeoDeliveryObservation)=>void):()=>void{if(typeof listener!=='function')throw Error('A Neo observer must be callable');listeners.add(listener);return()=>{listeners.delete(listener);};}};
}
