import {randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder,type EmitEvent} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {identifier} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {hash,readDirectoryPackageManifest,readPackageActivationState} from './data.ts';
import {PackageActivationStore} from './store.ts';
import {admitPackageActivationRecording,packageSettlementProof} from './recording.ts';
import {createPackageActivationChart} from './create-package-activation-chart.ts';
import {PACKAGE_RUNTIME_EVENT} from './stages.ts';
import {reconcilePackageActivation} from './reconcile.ts';
import {PACKAGE_STAGE_IDS,type DirectoryPackageSource,type PackageActivationDefinition,type PackageActivationState,type PackageReleaseTarget,type PackageRuntimePort} from './types.ts';

export interface PackageActivationWorkflowOptions {id:string;directory:string;package:DirectoryPackageSource;target:PackageReleaseTarget;runtime:PackageRuntimePort;configurationDigest:string;recorders?:readonly CombinedRecorder[];reconciliation?:{observe:PackageRuntimePort['observe'];configurationDigest:string}}
const labels=['Verify package','Stage files','Activate version','Observe running code'];
/** One immutable child operation; review/target authority remains in the parent deployment adapter. */
export class PackageActivationWorkflow {
 private readonly definition:PackageActivationDefinition;private readonly digest:string;private readonly store:PackageActivationStore;
 private readonly source:DirectoryPackageSource;private readonly target:PackageReleaseTarget;private readonly runtime:PackageRuntimePort;private readonly recorders:readonly CombinedRecorder[];
 private readonly reconciliation:NonNullable<PackageActivationWorkflowOptions['reconciliation']>;
 private readonly listeners=new Set<(state:PackageActivationState)=>void>();private live=false;
 constructor(options:PackageActivationWorkflowOptions){
  const manifest=readDirectoryPackageManifest(options.package?.manifest);if(!isAbsolute(options.directory)||typeof options.package.read!=='function')throw Error('package-private-registration-required');
  this.source={manifest,read:options.package.read.bind(options.package)};
  if(!options.target||['inspect','stage','activate','settle'].some(name=>typeof options.target[name as keyof PackageReleaseTarget]!=='function')||!options.runtime||['activate','observe'].some(name=>typeof options.runtime[name as keyof PackageRuntimePort]!=='function'))throw Error('package-private-ports-required');
  this.target={id:identifier(options.target.id,'package target'),inspect:options.target.inspect.bind(options.target),stage:options.target.stage.bind(options.target),activate:options.target.activate.bind(options.target),settle:options.target.settle.bind(options.target)};
  this.runtime={activate:options.runtime.activate.bind(options.runtime),observe:options.runtime.observe.bind(options.runtime)};this.recorders=[...options.recorders??[]];
  if(options.reconciliation&&typeof options.reconciliation.observe!=='function')throw Error('package-reconciliation-observer-required');
  this.reconciliation={observe:options.reconciliation?options.reconciliation.observe.bind(options.reconciliation):this.runtime.observe,configurationDigest:hash(options.reconciliation?.configurationDigest??options.configurationDigest)};
  this.definition={id:identifier(options.id,'package activation'),targetId:this.target.id,packageId:manifest.id,packageDigest:manifest.digest,configurationDigest:hash(options.configurationDigest)};this.digest=fingerprint(this.definition);this.store=new PackageActivationStore(resolve(options.directory));
 }
 subscribe(listener:(state:PackageActivationState)=>void){if(typeof listener!=='function')throw Error('package-listener-required');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 async snapshot():Promise<PackageActivationState>{return this.load();}
 reconcile():Promise<PackageActivationState>{return this.store.withLock(async()=>{
  const state=await this.load();return readPackageActivationState(await reconcilePackageActivation({state,store:this.store,target:this.target,runtime:{activate:this.runtime.activate,observe:this.reconciliation.observe},configurationDigest:this.reconciliation.configurationDigest,recorders:this.recorders,publish:value=>this.publish(value)}));
 });}
 start(input:{operationId:string}):Promise<PackageActivationState>{const operationId=identifier(input.operationId,'package operation');return this.store.withLock(async()=>{
  const loaded=await this.load();if(loaded.operationId&&loaded.operationId!==operationId)throw Error('package-operation-differs');if(['ready','verification-failed','failed'].includes(loaded.status))return loaded;if(loaded.status!=='idle')throw Error('package-effect-unconfirmed-inspect-before-another-attempt');
  const state=structuredClone(loaded);state.operationId=operationId;state.status='running';await this.store.save(state);this.live=true;this.publish(state);try{return await this.execute(state);}finally{this.live=false;}
 });}
 private async load(){const state=await this.store.load()??{version:1,kind:'package-activation-state',definition:this.definition,definitionDigest:this.digest,operationId:null,status:'idle',stages:PACKAGE_STAGE_IDS.map((id,index)=>({id,label:labels[index]!,status:'pending'})),events:[]} satisfies PackageActivationState;
  if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('package-activation-definition-changed');
  if(state.recording?.complete)await admitPackageActivationRecording(state,this.store.directory);
  return readPackageActivationState(state.status==='running'&&!this.live?{...state,status:'incomplete',error:'Inspect retained package and runtime outcomes before another attempt.'}:state);
 }
 private publish(state:PackageActivationState){for(const listener of this.listeners)try{listener(readPackageActivationState(state));}catch{/* Viewing cannot control installation. */}}
 private progress(state:PackageActivationState,event:EmitEvent){if(event.name!==PACKAGE_RUNTIME_EVENT)return;const value=event.payload as {stageId?:typeof PACKAGE_STAGE_IDS[number];status?:'running'|'passed'|'failed'};if(!PACKAGE_STAGE_IDS.includes(value?.stageId!)||!['running','passed','failed'].includes(value.status??'')||!Number.isFinite(event.timestamp))return;
  state.events.push({sequence:state.events.length+1,stageId:value.stageId!,status:value.status!,runtimeStageId:event.runtimeStageId,timestamp:event.timestamp});state.stages=state.stages.map(s=>s.id===value.stageId?{...s,status:value.status!}:s);
 }
 private async execute(state:PackageActivationState):Promise<PackageActivationState>{
  const id=randomUUID(),evidencePath=join(this.store.directory,id+'.json'),tracePath=join(this.store.directory,id+'.jsonl');let activationStarted=false;
  const chart=createPackageActivationChart({state,source:this.source,target:this.target,runtime:this.runtime,persist:async()=>{await this.store.save(state);this.publish(state);},activationStarted:()=>{activationStarted=true;}});
  const progress:CombinedRecorder={id:'iac-package-runtime-progress',onEmit:event=>this.progress(state,event),toSnapshot:()=>({name:'Package activation',data:{events:state.events},description:'Actual package verification, file staging, atomic activation and measured runtime identity.'})},control=controlDepRecorder({id:'iac-package-runtime-control'});
  let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,captureFailed=false,executionFailed=false;
  try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.enableNarrative();executor.attachCombinedRecorder(progress);executor.attachCombinedRecorder(control);for(const recorder of this.recorders)executor.attachCombinedRecorder(recorder);await executor.run();}catch{executionFailed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
  if(!executor){state.status='incomplete';state.error='Native package capture could not start.';await this.store.save(state);this.publish(state);return readPackageActivationState(state);}
  const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const value=control.asLookup()(commit.runtimeStageId);if(value)controlDeps[commit.runtimeStageId]=value;}
  captureFailed||=(snapshot.sink?.failed??0)>0;
  const complete=state.stages.every(s=>s.status==='passed')&&!!state.observation;let status:PackageActivationState['status']=captureFailed?'incomplete':executionFailed||!complete?activationStarted?'incomplete':'failed':!state.observation!.evidence.complete?'incomplete':state.observation!.ready&&state.observation!.packageDigest===this.source.manifest.digest?'ready':'verification-failed';
  const evidence={version:1,kind:'package-activation-native-evidence',runId:snapshot.runId,stack:this.definition.id,definitionDigest:this.digest,operationId:state.operationId,status,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},limitations:['Runtime identity is measured by the registered probe. Current symlinks and release markers alone do not prove loaded application code. No database restoration is implied.']};
  try{const retained=JSON.parse(JSON.stringify(evidence));await this.store.write(evidencePath,retained);state.recording={runId:snapshot.runId!,evidencePath,tracePath,digest:fingerprint(retained),complete:!captureFailed};}catch{captureFailed=true;status='incomplete';}
  state.status=status;
  if(state.recording?.complete)try{await admitPackageActivationRecording(state,this.store.directory);}catch{state.status='incomplete';state.recording.complete=false;}
  if(['ready','verification-failed'].includes(state.status))try{await this.target.settle(state.receipt!,packageSettlementProof(state),{operationId:state.operationId!,packageDigest:this.definition.packageDigest,targetId:this.target.id});}catch{state.status='incomplete';}
  if(['failed','incomplete'].includes(state.status))state.error=state.status==='incomplete'?'Package or runtime outcome is uncertain; inspect retained evidence before another attempt.':'Package preparation failed before activation; its result is retained.';
  await this.store.save(state);this.publish(state);return readPackageActivationState(state);
 }
}
