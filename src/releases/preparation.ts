import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder, type EmitEvent } from 'footprintjs';
import { fileSink } from 'footprintjs/sinks';
import { controlDepRecorder } from 'footprintjs/trace';
import { readDeliveryBuild,readDeliveryDefinition,readDeliveryPublication,readSourceRevision } from '../delivery/data.ts';
import { recordedDeliveryDefinition, recordedDeliveryResult } from '../delivery/summary.ts';
import { DELIVERY_EVENT, type DeliveryAdapters, type DeliveryEvent, type SourceRevision } from '../delivery/types.ts';
import { canonical, fingerprint } from '../util.ts';
import { createReleaseBuildChart } from './create-release-build-chart.ts';
import { defineReleaseManifest } from './manifest.ts';
import { readReleasePreparationState } from './preparation-data.ts';
import { RELEASE_BUILD_STAGES, type ReleasePreparationDefinition, type ReleasePreparationState } from './preparation-types.ts';
import { FileReleasePreparationStore } from './preparation-store.ts';
import { loadReleaseBuildRecording } from './recording.ts';
import { readPublicReleaseArtifacts } from './data.ts';

export interface ReleasePreparationOptions {
  definition:ReleasePreparationDefinition;store:FileReleasePreparationStore;
  adapters:Pick<DeliveryAdapters,'source'|'build'|'artifacts'>;recorders?:readonly CombinedRecorder[];
  /** Pin the reviewed catalog resolution. A moved tag then fails before fetch or build. */
  expectedRevision?:SourceRevision;
}
/** Resolve/fetch/build/publish once; all environment stages consume the same sealed manifest. */
export class ReleasePreparationWorkflow {
  private readonly definition:ReleasePreparationDefinition;private readonly digest:string;
  private readonly listeners=new Set<(state:ReleasePreparationState)=>void>();
  private readonly adapters:ReleasePreparationOptions['adapters'];
  private readonly expectedRevision?:SourceRevision;
  private readonly options:ReleasePreparationOptions;
  constructor(options:ReleasePreparationOptions){
    this.options={...options};
    this.definition=readDeliveryDefinition(options.definition);this.expectedRevision=options.expectedRevision===undefined?undefined:readSourceRevision(options.expectedRevision);
    if(this.expectedRevision&&(this.expectedRevision.repository!==this.definition.source.repository||this.expectedRevision.ref!==this.definition.source.ref))throw Error('Selected source differs from configured repository/ref');
    this.digest=fingerprint(this.expectedRevision?{definition:this.definition,expectedRevision:this.expectedRevision}:this.definition);
    const input=options.adapters;
    if(!input||typeof input.source?.resolve!=='function'||typeof input.source?.fetch!=='function'||typeof input.build?.build!=='function'||typeof input.artifacts?.publish!=='function')throw Error('Configure each release build adapter');
    this.adapters={source:{resolve:input.source.resolve.bind(input.source),fetch:input.source.fetch.bind(input.source)},
      build:{async build(...args){const result=readDeliveryBuild(await input.build.build(...args));readPublicReleaseArtifacts(result.artifacts);return result;}},
      artifacts:{async publish(...args){const result=readDeliveryPublication(await input.artifacts.publish(...args));readPublicReleaseArtifacts(result.artifacts);return result;}}};
  }
  subscribe(listener:(state:ReleasePreparationState)=>void):()=>void{
    if(typeof listener!=='function')throw Error('A release listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};
  }
  async snapshot():Promise<ReleasePreparationState>{
    const state=await this.options.store.load()??{version:1,kind:'release-preparation',definition:this.definition,definitionDigest:this.digest,
      executionId:null,status:'idle',stages:RELEASE_BUILD_STAGES.map((id,i)=>({id,label:['Choose exact version','Get code','Build package','Store package'][i]!,status:'pending'})),events:[],results:{},recordings:[],...(this.expectedRevision?{expectedRevision:this.expectedRevision}:{})};
    if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('Release preparation host binding changed');
    if(state.status==='passed')await this.verifyRecording(state);
    return readReleasePreparationState(state);
  }
  start():Promise<ReleasePreparationState>{return this.options.store.withLock(async()=>{
    const state=structuredClone(await this.snapshot());if(state.status==='passed')return state;
    if(state.status!=='idle')throw Error('This release build already started. Inspect its retained outcome before creating another attempt.');
    state.executionId=randomUUID();state.status='running';await this.options.store.save(state);this.publish(state);return this.run(state);
  });}
  private publish(state:ReleasePreparationState){const copy=readReleasePreparationState(state);for(const listener of this.listeners)try{listener(copy);}catch{/* A viewer cannot control execution. */}}
  private async verifyRecording(state:ReleasePreparationState){
    const receipt=state.recordings[0]!;
    if(dirname(receipt.evidencePath)!==this.options.store.directory||dirname(receipt.tracePath)!==this.options.store.directory)throw Error('Release receipt left its bound store');
    const raw=await loadReleaseBuildRecording(receipt.evidencePath,receipt.tracePath,{runId:receipt.runId,executionId:state.executionId!,definitionDigest:this.digest});
    if(raw.status!=='passed')throw Error('Prepared release native receipt changed');
    const shared=(raw.snapshot as {sharedState?:Record<string,unknown>}).sharedState;
    if(!shared||canonical(shared.definition)!==canonical(recordedDeliveryDefinition(this.definition))
      ||Object.keys(state.results).some(key=>canonical(shared[key])!==canonical(recordedDeliveryResult(key as keyof typeof state.results,state.results))))throw Error('Prepared release differs from native build recording');
  }
  private async run(state:ReleasePreparationState):Promise<ReleasePreparationState>{
    const store=this.options.store,id=randomUUID(),evidencePath=join(store.directory,id+'.json'),tracePath=join(store.directory,id+'.jsonl');
    const chart=createReleaseBuildChart({definition:this.definition,definitionDigest:this.digest,executionId:state.executionId!,adapters:this.adapters,expectedRevision:this.expectedRevision,
      results:state.results,persist:async()=>{await store.save(state);this.publish(state);}});
    const progress:CombinedRecorder={id:'iac-release-build-progress',onEmit:event=>this.event(state,event),
      toSnapshot:()=>({name:'Build release once',data:{events:state.events},description:'Exact source and published artifact identities.'})};
    const control=controlDepRecorder({id:'iac-release-build-control'});
    let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,failed=false,captureFailed=false;
    try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});
      executor.enableNarrative();executor.attachCombinedRecorder(progress);executor.attachCombinedRecorder(control);
      for(const recorder of this.options.recorders??[])executor.attachCombinedRecorder(recorder);await executor.run();
    }catch{failed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
    if(!executor){state.status='incomplete';state.error='Native build recording could not start; no build adapter was invoked.';await store.save(state);this.publish(state);return readReleasePreparationState(state);}
    const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};
    for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const entry=control.asLookup()(commit.runtimeStageId);if(entry)controlDeps[commit.runtimeStageId]=entry;}
    captureFailed||=(snapshot.sink?.failed??0)>0;
    const complete=state.stages.every(stage=>stage.status==='passed')&&!!state.results.publication;
    const recordedFailure=state.stages.some(stage=>stage.status==='failed');
    let release:ReturnType<typeof defineReleaseManifest>|undefined;
    if(!failed&&complete)try{release=defineReleaseManifest({id:this.definition.id,label:this.definition.label,source:state.results.revision!,recipe:this.definition.recipe,artifacts:state.results.publication!.artifacts});}catch{captureFailed=true;}
    const status=captureFailed||(failed||!complete)&&!recordedFailure?'incomplete':recordedFailure?'failed':'passed';
    try{await store.writeJson(evidencePath,{version:1,kind:'release-build-native-evidence',runId:snapshot.runId,stack:this.definition.id,
      executionId:state.executionId,definitionDigest:this.digest,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),
      narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},status});
    }catch{captureFailed=true;}
    state.status=captureFailed?'incomplete':status;state.recordings.push({runId:snapshot.runId!,evidencePath,tracePath,status:state.status});
    if(state.status==='passed'&&release)state.release=release;else state.error='Release build or native capture did not confirm completion; inspect the retained attempt.';
    await store.save(state);this.publish(state);return readReleasePreparationState(state);
  }
  private event(state:ReleasePreparationState,event:EmitEvent){
    if(event.name!==DELIVERY_EVENT)return;const value=event.payload as Partial<DeliveryEvent>;
    if(value.executionId!==state.executionId||!RELEASE_BUILD_STAGES.includes(value.stageId as typeof RELEASE_BUILD_STAGES[number])||!['running','passed','failed'].includes(value.status??'')||!Number.isFinite(event.timestamp))return;
    const item:DeliveryEvent={sequence:state.events.length+1,executionId:state.executionId!,stageId:value.stageId!,status:value.status!,timestamp:event.timestamp,runtimeStageId:event.runtimeStageId};
    state.events.push(item);state.stages=state.stages.map(stage=>stage.id===item.stageId?{...stage,status:item.status}:stage);
  }
}
