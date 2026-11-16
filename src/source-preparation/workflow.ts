import {dirname,resolve} from 'node:path';
import type {CombinedRecorder} from 'footprintjs';
import {canonical,fingerprint} from '../util.ts';
import type {DeliveryDefinition} from '../delivery/types.ts';
import {recordedDeliveryDefinition,recordedDeliveryResult} from '../delivery/summary.ts';
import {createSourcePreparationChart} from './create-source-preparation-chart.ts';
import {readSourcePreparationDefinition,readSourcePreparationState} from './data.ts';
import {loadSourcePreparationRecording} from './recording.ts';
import {FileSourcePreparationStore} from './store.ts';
import {SOURCE_PREPARATION_STAGE_IDS,type SourcePreparationAdapters,type SourcePreparationDefinition,type SourcePreparationState} from './types.ts';
import {capturePreparationAdapters} from '../preparation/adapters.ts';
import {startPreparationAttempt} from '../preparation/attempt.ts';
import {PREPARATION_STAGE_LABELS,recordPreparationProgress} from '../preparation/progress.ts';
import {runNativePreparation} from '../preparation/native-run.ts';

export interface SourcePreparationWorkflowOptions {definition:SourcePreparationDefinition;store:FileSourcePreparationStore;adapters:SourcePreparationAdapters;recorders?:readonly CombinedRecorder[]}
/** Native, one-shot source acquisition and packaging before a separate reviewed deployment. */
export class SourcePreparationWorkflow {
 private readonly definition:SourcePreparationDefinition;private readonly base:DeliveryDefinition;private readonly digest:string;private readonly ports:SourcePreparationAdapters;
 private readonly listeners=new Set<(state:SourcePreparationState)=>void>();private live=false;private readonly options:SourcePreparationWorkflowOptions;
 constructor(options:SourcePreparationWorkflowOptions){this.definition=readSourcePreparationDefinition(options.definition);const {expectedRevision:_,...base}=this.definition;this.base=base;this.digest=fingerprint(this.definition);this.ports=capturePreparationAdapters(options.adapters,{error:'Register every source preparation adapter'});this.options={...options,definition:this.definition,adapters:this.ports,...options.recorders?{recorders:Object.freeze([...options.recorders])}:{}};}
 subscribe(listener:(state:SourcePreparationState)=>void):()=>void{if(typeof listener!=='function')throw Error('Source preparation listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 snapshot():Promise<SourcePreparationState>{return this.load();}
 start():Promise<SourcePreparationState>{return startPreparationAttempt({store:this.options.store,load:()=>this.load(),publish:state=>this.publish(state),
  blocked:'This source preparation already started; inspect its retained or uncertain outcome and use a new bound attempt.',
  run:async state=>{this.live=true;try{return await this.execute(state);}finally{this.live=false;}}});}
 private async load():Promise<SourcePreparationState>{
  const state=await this.options.store.load()??{version:1,kind:'source-preparation-state',definition:this.definition,definitionDigest:this.digest,executionId:null,status:'idle',stages:SOURCE_PREPARATION_STAGE_IDS.map((id,index)=>({id,label:PREPARATION_STAGE_LABELS[index]!,status:'pending'})),events:[],results:{},recordings:[]} satisfies SourcePreparationState;
  if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('Source preparation definition, target, version or recipe changed');
  if(state.status==='passed'){
   const receipt=state.recordings[0]!;
   if(dirname(resolve(receipt.evidencePath))!==this.options.store.directory||dirname(resolve(receipt.tracePath))!==this.options.store.directory)throw Error('Source preparation native receipt left its bound store');
   const native=await loadSourcePreparationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:this.digest,executionId:state.executionId!,tracePath:receipt.tracePath,status:'passed'}),shared=native.snapshot.sharedState;
   const progress=native.snapshot.recorders?.filter(value=>value.id==='iac-source-preparation-progress');
   if(canonical(shared.definition)!==canonical(recordedDeliveryDefinition(this.base))||canonical(shared.expectedSource)!==canonical(this.definition.expectedRevision?recordedDeliveryResult('revision',{revision:this.definition.expectedRevision}):undefined)
    ||progress?.length!==1||canonical((progress[0]?.data as {events?:unknown})?.events)!==canonical(state.events)
    ||Object.keys(state.results).some(key=>canonical(shared[key])!==canonical(recordedDeliveryResult(key as keyof typeof state.results,state.results))))throw Error('Source preparation receipts differ from their complete native recording');
  }
  return readSourcePreparationState(state.status==='running'&&!this.live?{...state,status:'incomplete',error:'The source preparation is not active on this host; inspect retained source and build outcomes before another attempt.'}:state);
 }
 private publish(state:SourcePreparationState){for(const listener of this.listeners)try{listener(readSourcePreparationState(state));}catch{/* Observers cannot affect source preparation. */}}
 private async execute(state:SourcePreparationState):Promise<SourcePreparationState>{
  const store=this.options.store;
  const chart=createSourcePreparationChart({definition:this.base,definitionDigest:this.digest,executionId:state.executionId!,adapters:this.ports,results:state.results,
   ...this.definition.expectedRevision?{expectedRevision:this.definition.expectedRevision}:{},persist:async()=>{await store.save(state);this.publish(state);}});
  const progress:CombinedRecorder={id:'iac-source-preparation-progress',onEmit:event=>recordPreparationProgress(state,event),toSnapshot:()=>({name:'Source preparation',data:{events:state.events},description:'Actual source resolution, fetch, packaging and artifact publication before deployment review.'})};
  const outcome=await runNativePreparation({chart,directory:store.directory,stack:this.definition.id,definitionDigest:this.digest,executionId:state.executionId!,
   evidenceKind:'source-preparation-native-evidence',controlId:'iac-source-preparation-control',progress,recorders:this.options.recorders,
   limitations:['Source preparation does not deploy or verify application resources. External build internals require their own recording.'],
   complete:()=>state.stages.every(stage=>stage.status==='passed')&&!!state.results.publication,failed:()=>state.stages.some(stage=>stage.status==='failed'),writeJson:store.writeJson.bind(store)});
  state.status=outcome.status;
  if(outcome.recording)state.recordings.push(outcome.recording);
  if(!outcome.started)state.error='Native source recording could not start; inspect the retained attempt.';
  else if(state.status!=='passed')state.error='Source preparation did not confirm a complete result. Inspect retained receipts before another immutable attempt.';
  await store.save(state);this.publish(state);return readSourcePreparationState(state);
 }
}
