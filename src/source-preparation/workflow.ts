import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder,type EmitEvent} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {canonical,fingerprint} from '../util.ts';
import {DELIVERY_EVENT,type DeliveryDefinition} from '../delivery/types.ts';
import {recordedDeliveryDefinition,recordedDeliveryResult} from '../delivery/summary.ts';
import {createSourcePreparationChart} from './create-source-preparation-chart.ts';
import {readSourcePreparationDefinition,readSourcePreparationState} from './data.ts';
import {loadSourcePreparationRecording} from './recording.ts';
import {FileSourcePreparationStore} from './store.ts';
import {SOURCE_PREPARATION_STAGE_IDS,type SourcePreparationAdapters,type SourcePreparationDefinition,type SourcePreparationState} from './types.ts';

export interface SourcePreparationWorkflowOptions {definition:SourcePreparationDefinition;store:FileSourcePreparationStore;adapters:SourcePreparationAdapters;recorders?:readonly CombinedRecorder[]}
const labels=['Choose exact version','Get code','Build package','Store package'];
function bindAdapters(input:SourcePreparationAdapters):SourcePreparationAdapters{
 const methods={source:['resolve','fetch'],build:['build'],artifacts:['publish']} as const,result:Record<string,unknown>={};
 for(const [key,names] of Object.entries(methods)){const adapter=input?.[key as keyof SourcePreparationAdapters] as unknown as Record<string,unknown>|undefined;if(!adapter||names.some(name=>typeof adapter[name]!=='function'))throw Error('Register every source preparation adapter');result[key]=Object.freeze(Object.fromEntries(names.map(name=>[name,(adapter[name] as Function).bind(adapter)])));}
 return Object.freeze(result) as unknown as SourcePreparationAdapters;
}
/** Native, one-shot source acquisition and packaging before a separate reviewed deployment. */
export class SourcePreparationWorkflow {
 private readonly definition:SourcePreparationDefinition;private readonly base:DeliveryDefinition;private readonly digest:string;private readonly ports:SourcePreparationAdapters;
 private readonly listeners=new Set<(state:SourcePreparationState)=>void>();private live=false;private readonly options:SourcePreparationWorkflowOptions;
 constructor(options:SourcePreparationWorkflowOptions){this.definition=readSourcePreparationDefinition(options.definition);const {expectedRevision:_,...base}=this.definition;this.base=base;this.digest=fingerprint(this.definition);this.ports=bindAdapters(options.adapters);this.options={...options,definition:this.definition,adapters:this.ports,...options.recorders?{recorders:Object.freeze([...options.recorders])}:{}};}
 subscribe(listener:(state:SourcePreparationState)=>void):()=>void{if(typeof listener!=='function')throw Error('Source preparation listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 snapshot():Promise<SourcePreparationState>{return this.load();}
 start():Promise<SourcePreparationState>{return this.options.store.withLock(async()=>{
  const loaded=await this.load();if(loaded.status==='passed')return loaded;if(loaded.status!=='idle')throw Error('This source preparation already started; inspect its retained or uncertain outcome and use a new bound attempt.');
  const state=structuredClone(loaded);state.executionId=randomUUID();state.status='running';await this.options.store.save(state);this.publish(state);
  this.live=true;try{return await this.execute(state);}finally{this.live=false;}
 });}
 private async load():Promise<SourcePreparationState>{
  const state=await this.options.store.load()??{version:1,kind:'source-preparation-state',definition:this.definition,definitionDigest:this.digest,executionId:null,status:'idle',stages:SOURCE_PREPARATION_STAGE_IDS.map((id,index)=>({id,label:labels[index]!,status:'pending'})),events:[],results:{},recordings:[]} satisfies SourcePreparationState;
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
 private record(state:SourcePreparationState,event:EmitEvent){
  if(event.name!==DELIVERY_EVENT)return;const value=event.payload as Record<string,unknown>;
  if(!value||value.executionId!==state.executionId||!SOURCE_PREPARATION_STAGE_IDS.includes(value.stageId as typeof SOURCE_PREPARATION_STAGE_IDS[number])||!['running','passed','failed'].includes(String(value.status))||!Number.isFinite(event.timestamp))return;
  const item={sequence:state.events.length+1,executionId:state.executionId!,stageId:value.stageId as typeof SOURCE_PREPARATION_STAGE_IDS[number],status:value.status as 'running'|'passed'|'failed',timestamp:event.timestamp,runtimeStageId:event.runtimeStageId};
  state.events.push(item);state.stages=state.stages.map(stage=>stage.id===item.stageId?{...stage,status:item.status}:stage);
 }
 private async execute(state:SourcePreparationState):Promise<SourcePreparationState>{
  const store=this.options.store,id=randomUUID(),evidencePath=join(store.directory,id+'.json'),tracePath=join(store.directory,id+'.jsonl');
  const chart=createSourcePreparationChart({definition:this.base,definitionDigest:this.digest,executionId:state.executionId!,adapters:this.ports,results:state.results,
   ...this.definition.expectedRevision?{expectedRevision:this.definition.expectedRevision}:{},persist:async()=>{await store.save(state);this.publish(state);}});
  const progress:CombinedRecorder={id:'iac-source-preparation-progress',onEmit:event=>this.record(state,event),toSnapshot:()=>({name:'Source preparation',data:{events:state.events},description:'Actual source resolution, fetch, packaging and artifact publication before deployment review.'})};
  const control=controlDepRecorder({id:'iac-source-preparation-control'});let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,executionFailed=false,captureFailed=false;
  try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.enableNarrative();executor.attachCombinedRecorder(progress);executor.attachCombinedRecorder(control);for(const recorder of this.options.recorders??[])executor.attachCombinedRecorder(recorder);await executor.run();}
  catch{executionFailed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
  if(!executor){state.status='incomplete';state.error='Native source recording could not start; inspect the retained attempt.';await store.save(state);this.publish(state);return readSourcePreparationState(state);}
  const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const value=control.asLookup()(commit.runtimeStageId);if(value)controlDeps[commit.runtimeStageId]=value;}
  captureFailed||=(snapshot.sink?.failed??0)>0;const failed=state.stages.some(stage=>stage.status==='failed'),complete=state.stages.every(stage=>stage.status==='passed')&&!!state.results.publication;
  const status=captureFailed||(executionFailed||!complete)&&!failed?'incomplete':failed?'failed':'passed';
  try{await store.writeJson(evidencePath,{version:1,kind:'source-preparation-native-evidence',runId:snapshot.runId,stack:this.definition.id,definitionDigest:this.digest,executionId:state.executionId,status,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},limitations:['Source preparation does not deploy or verify application resources. External build internals require their own recording.']});}catch{captureFailed=true;}
  state.status=captureFailed?'incomplete':status;state.recordings.push({runId:snapshot.runId!,evidencePath,tracePath,status:state.status});
  if(state.status!=='passed')state.error='Source preparation did not confirm a complete result. Inspect retained receipts before another immutable attempt.';
  await store.save(state);this.publish(state);return readSourcePreparationState(state);
 }
}
