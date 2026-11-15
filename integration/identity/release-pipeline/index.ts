import { join, resolve } from 'node:path';
import { identifier, freeze } from '../../../src/graph/data.ts';
import { readReleaseManifest } from '../../../src/releases/manifest.ts';
import { readDeliveryPublication } from '../../../src/delivery/data.ts';
import { canonical, fingerprint } from '../../../src/util.ts';
import { PipelineWorkflow } from '../../../src/pipeline/workflow.ts';
import { FilePipelineStore, FilePipelineTargetStore } from '../../../src/pipeline/store.ts';
import { compileRolloutPlans } from '../../../src/pipeline/compile.ts';
import { directStrategy } from '../../../src/pipeline/strategies.ts';
import type { PipelineDefinition, PipelineRegistry } from '../../../src/pipeline/types.ts';
import { identityEngine } from '../engine.ts';
import { loadIdentityTarget, type IdentityTarget } from '../target.ts';
import { prepareNeoDeliveryMaster } from '../github-delivery/baseline.ts';
import { neoDeliveryTarget } from '../github-delivery/target.ts';
import type { NeoDeliveryObservation, NeoDeliveryBaseline } from '../github-delivery/types.ts';
import { neoIdentityChecks } from '../checks.ts';
import { neoReleaseCheckRunner } from './checks.ts';
import { neoReleaseRolloutAdapter } from './rollout.ts';
import { lockNeoReleasePipeline } from './lock.ts';
import type { NeoPreparedRelease, NeoReleaseEnvironment, NeoReleaseEnvironmentView, NeoReleasePipelineOptions } from './types.ts';

export * from './types.ts';
export { createNeoReleasePreparation } from './preparation.ts';
export { bindNeoReleaseCandidate } from './candidate.ts';
export { observeNeoRelease } from './observe.ts';
export { neoImageConfigDigest } from './image-config.ts';

/** Neo consumes the generic release/pipeline library. Its local-kind adapter exposes direct rollout only. */
export async function createNeoReleasePipeline(input: NeoReleasePipelineOptions) {
  if(!Array.isArray(input.environments)||!input.environments.length||input.environments.length>8||!Array.isArray(input.releases)||!input.releases.length||input.releases.length>128)throw Error('Register bounded Neo environments and prepared releases');
  const options={...input,environments:input.environments.map(environment=>{
    identifier(environment.id,'Neo environment');if(typeof environment.label!=='string'||!environment.label.trim()||environment.label.length>160
      ||!['automatic','manual'].includes(environment.promotion)||environment.rollback!=='disabled')throw Error('Neo supports fixed direct environments with rollback disabled');
    return freeze({...environment,targetPath:resolve(environment.targetPath)});
  })};
  if(new Set(options.environments.map(environment=>environment.id)).size!==options.environments.length)throw Error('Duplicate Neo environment');
  const releases:readonly NeoPreparedRelease[]=Object.freeze(input.releases.map(item=>freeze({manifest:readReleaseManifest(item.manifest),publication:readDeliveryPublication(item.publication),
    ...(item.buildTargetPath?{buildTargetPath:resolve(item.buildTargetPath)}:{})})));
  if(new Set(releases.map(item=>item.manifest.id)).size!==releases.length)throw Error('Duplicate prepared Neo release ID');
  const listeners=new Set<(event:NeoDeliveryObservation)=>void>(),emit=(event:NeoDeliveryObservation)=>{for(const listener of listeners)try{listener(event);}catch{/* Views cannot change the release. */}};
  const load=options.loadTarget??loadIdentityTarget,prepared:{environment:NeoReleaseEnvironment;target:IdentityTarget;baseline:NeoDeliveryBaseline}[]=[];
  for(const environment of options.environments){
    const target=await load(environment.targetPath);if(environment.targetPath!==join(target.directory,'target.json'))throw Error('Pin canonical Neo environment files');
    const baseline=await prepareNeoDeliveryMaster(target,releases[0]!.manifest.source.repository,(options.engineFactory??identityEngine)(target),emit);
    prepared.push({environment,target,baseline:baseline.baseline});
  }
  const environments:readonly NeoReleaseEnvironmentView[]=Object.freeze(prepared.map(({environment,target})=>freeze({id:environment.id,label:environment.label,target:neoDeliveryTarget(target)})));
  if(new Set(environments.map(environment=>canonical(environment.target))).size!==environments.length)throw Error('Neo environments need distinct prepared targets');
  const target=prepared[0]!.target,id=identifier(options.id??'neo-releases-'+target.id,'Neo pipeline host'),directory=resolve(options.directory??join(target.directory,'release-pipelines',id));
  const suite={id:'neo-identity-access',label:'Neo connections, login and permissions',kind:'native-neo',digest:fingerprint({version:1,connections:3,access:neoIdentityChecks})};
  const checks=neoReleaseCheckRunner(options,releases.map(item=>item.manifest),suite,directory,emit);
  const registry:PipelineRegistry={strategies:[directStrategy()],checks:[checks],adapters:options.environments.map(environment=>neoReleaseRolloutAdapter(options,environment,directory,releases,emit))};
  return {target,directory,baseline:prepared[0]!.baseline,environments,baselines:Object.fromEntries(prepared.map(item=>[item.environment.id,item.baseline])),suite,registry,
    listReleases:()=>releases.map(item=>readReleaseManifest(item.manifest)),
    async createPipeline(selection:{id:string;releaseId:string;stageIds?:readonly string[]}){
      identifier(selection.id,'Neo pipeline attempt');const selected=releases.find(item=>item.manifest.id===selection.releaseId);if(!selected)throw Error('Choose a registered prepared Neo release');
      const stageIds=selection.stageIds??environments.map(environment=>environment.id);
      if(!stageIds.length||new Set(stageIds).size!==stageIds.length||stageIds.some(id=>!environments.some(environment=>environment.id===id))
        ||stageIds.some((id,index)=>options.environments.findIndex(environment=>environment.id===id)<(index?options.environments.findIndex(environment=>environment.id===stageIds[index-1]):0)))throw Error('Choose Neo stages in registered order');
      const definition:PipelineDefinition={version:1,id:selection.id,label:'Neo release',configurationDigest:fingerprint({version:2,environments,suite,mode:'direct-assessed-no-restore'}),
        stages:stageIds.map(id=>{const environment=options.environments.find(environment=>environment.id===id)!,view=environments.find(environment=>environment.id===id)!;
          return {id,label:environment.label,target:view.target,strategyId:'direct',adapterId:'neo-direct-'+id,checks:[{runnerId:checks.id,suiteId:suite.id,suiteDigest:suite.digest}],rollback:'disabled',promotion:environment.promotion};})};
      const plans=Object.fromEntries(compileRolloutPlans(definition,selected.manifest,registry).map(plan=>[plan.stageId,plan.plan]));
      const workflow=new PipelineWorkflow({definition,release:selected.manifest,registry,store:new FilePipelineStore(join(directory,'attempts',selection.id)),targetStore:new FilePipelineTargetStore(join(directory,'targets'))});
      return {workflow:lockNeoReleasePipeline(prepared.map(item=>item.target.directory),workflow),plans};
    },
    subscribe(listener:(event:NeoDeliveryObservation)=>void):()=>void{if(typeof listener!=='function')throw Error('A Neo observer must be callable');listeners.add(listener);return()=>{listeners.delete(listener);};}
  };
}
