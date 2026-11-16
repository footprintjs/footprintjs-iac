import { dirname } from 'node:path';
import type {CombinedRecorder} from 'footprintjs';
import { readDeliveryBuild,readDeliveryDefinition,readDeliveryPublication,readSourceRevision } from '../delivery/data.ts';
import { recordedDeliveryDefinition, recordedDeliveryResult } from '../delivery/summary.ts';
import type {DeliveryAdapters,SourceRevision} from '../delivery/types.ts';
import { canonical, fingerprint } from '../util.ts';
import { createReleaseBuildChart } from './create-release-build-chart.ts';
import { defineReleaseManifest } from './manifest.ts';
import { readReleasePreparationState } from './preparation-data.ts';
import { RELEASE_BUILD_STAGES, type ReleasePreparationDefinition, type ReleasePreparationState } from './preparation-types.ts';
import { FileReleasePreparationStore } from './preparation-store.ts';
import { loadReleaseBuildRecording } from './recording.ts';
import { readPublicReleaseArtifacts } from './data.ts';
import {capturePreparationAdapters} from '../preparation/adapters.ts';
import {startPreparationAttempt} from '../preparation/attempt.ts';
import {PREPARATION_STAGE_LABELS,recordPreparationProgress} from '../preparation/progress.ts';
import {runNativePreparation} from '../preparation/native-run.ts';

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
    this.options={...options,...options.recorders?{recorders:Object.freeze([...options.recorders])}:{}};
    this.definition=readDeliveryDefinition(options.definition);this.expectedRevision=options.expectedRevision===undefined?undefined:readSourceRevision(options.expectedRevision);
    if(this.expectedRevision&&(this.expectedRevision.repository!==this.definition.source.repository||this.expectedRevision.ref!==this.definition.source.ref))throw Error('Selected source differs from configured repository/ref');
    this.digest=fingerprint(this.expectedRevision?{definition:this.definition,expectedRevision:this.expectedRevision}:this.definition);
    this.adapters=capturePreparationAdapters(options.adapters,{error:'Configure each release build adapter',
      build(input){const result=readDeliveryBuild(input);readPublicReleaseArtifacts(result.artifacts);return result;},
      publication(input){const result=readDeliveryPublication(input);readPublicReleaseArtifacts(result.artifacts);return result;}});
  }
  subscribe(listener:(state:ReleasePreparationState)=>void):()=>void{
    if(typeof listener!=='function')throw Error('A release listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};
  }
  async snapshot():Promise<ReleasePreparationState>{
    const state=await this.options.store.load()??{version:1,kind:'release-preparation',definition:this.definition,definitionDigest:this.digest,
      executionId:null,status:'idle',stages:RELEASE_BUILD_STAGES.map((id,i)=>({id,label:PREPARATION_STAGE_LABELS[i]!,status:'pending'})),events:[],results:{},recordings:[],...(this.expectedRevision?{expectedRevision:this.expectedRevision}:{})};
    if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('Release preparation host binding changed');
    if(state.status==='passed')await this.verifyRecording(state);
    return readReleasePreparationState(state);
  }
  start():Promise<ReleasePreparationState>{return startPreparationAttempt({store:this.options.store,load:()=>this.snapshot(),publish:state=>this.publish(state),
    blocked:'This release build already started. Inspect its retained outcome before creating another attempt.',replay:state=>structuredClone(state),run:state=>this.run(state)});}
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
    const store=this.options.store;
    const chart=createReleaseBuildChart({definition:this.definition,definitionDigest:this.digest,executionId:state.executionId!,adapters:this.adapters,expectedRevision:this.expectedRevision,
      results:state.results,persist:async()=>{await store.save(state);this.publish(state);}});
    const progress:CombinedRecorder={id:'iac-release-build-progress',onEmit:event=>recordPreparationProgress(state,event),
      toSnapshot:()=>({name:'Build release once',data:{events:state.events},description:'Exact source and published artifact identities.'})};
    let release:ReturnType<typeof defineReleaseManifest>|undefined;
    const outcome=await runNativePreparation({chart,directory:store.directory,stack:this.definition.id,definitionDigest:this.digest,executionId:state.executionId!,
      evidenceKind:'release-build-native-evidence',controlId:'iac-release-build-control',progress,recorders:this.options.recorders,
      complete:()=>state.stages.every(stage=>stage.status==='passed')&&!!state.results.publication,failed:()=>state.stages.some(stage=>stage.status==='failed'),
      onComplete:()=>{release=defineReleaseManifest({id:this.definition.id,label:this.definition.label,source:state.results.revision!,recipe:this.definition.recipe,artifacts:state.results.publication!.artifacts});},writeJson:store.writeJson.bind(store)});
    state.status=outcome.status;if(outcome.recording)state.recordings.push(outcome.recording);
    if(!outcome.started)state.error='Native build recording could not start; no build adapter was invoked.';
    else if(state.status==='passed'&&release)state.release=release;
    else state.error='Release build or native capture did not confirm completion; inspect the retained attempt.';
    await store.save(state);this.publish(state);return readReleasePreparationState(state);
  }
}
