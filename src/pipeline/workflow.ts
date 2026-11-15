import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { FlowChartExecutor,type CombinedRecorder,type EmitEvent } from 'footprintjs';
import { fileSink } from 'footprintjs/sinks';
import { controlDepRecorder } from 'footprintjs/trace';
import { canonical,fingerprint } from '../util.ts';
import { readReleaseManifest } from '../releases/manifest.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import { compileRolloutPlans,type CompiledRollout } from './compile.ts';
import { createPipelineStageChart } from './create-stage-chart.ts';
import { createPipelineRecoveryChart } from './create-recovery-chart.ts';
import { object,readPipelineDefinition,readPipelineState,text } from './data.ts';
import { loadPipelineRecording } from './recording.ts';
import { recordedOperation,recordedPipelineDefinition,recordedStage } from './summary.ts';
import { FilePipelineStore,FilePipelineTargetStore,type PipelineTargetState } from './store.ts';
import type { PipelineStages } from './stages.ts';
import { PIPELINE_EVENT,type PipelineActionRequest,type PipelineDefinition,type PipelinePendingAction,type PipelineRegistry,type PipelineStageState,type PipelineState,type PipelineWorkflowPort } from './types.ts';

export interface PipelineWorkflowOptions {
  definition:PipelineDefinition;release:ReleaseManifest;registry:PipelineRegistry;
  store:FilePipelineStore;targetStore:FilePipelineTargetStore;recorders?:readonly CombinedRecorder[];
}
function bindRegistry(input:PipelineRegistry):PipelineRegistry{
  return {strategies:input.strategies.map(strategy=>({id:strategy.id,label:strategy.label,plan:strategy.plan.bind(strategy)})),
    adapters:input.adapters.map(adapter=>({id:adapter.id,label:adapter.label,capabilities:Object.freeze([...adapter.capabilities]),
      execute:adapter.execute.bind(adapter),observe:adapter.observe.bind(adapter),...(adapter.admit?{admit:adapter.admit.bind(adapter)}:{})})),
    checks:input.checks.map(runner=>({id:runner.id,suites:runner.suites.bind(runner),run:runner.run.bind(runner)}))};
}
/** One immutable release attempt. Continuations are explicit gated segments; uncertain effects are never retried. */
export class PipelineWorkflow implements PipelineWorkflowPort {
  private readonly definition:PipelineDefinition;private readonly release:ReleaseManifest;private readonly registry:PipelineRegistry;
  private readonly plans:readonly CompiledRollout[];private readonly definitionDigest:string;
  private readonly listeners=new Set<(state:PipelineState)=>void>();
  private readonly options:PipelineWorkflowOptions;
  constructor(options:PipelineWorkflowOptions){
    this.options=options;
    this.definition=readPipelineDefinition(options.definition);this.release=readReleaseManifest(options.release);
    this.registry=bindRegistry(options.registry);this.plans=compileRolloutPlans(this.definition,this.release,this.registry);
    this.definitionDigest=fingerprint({definition:this.definition,release:this.release,plans:this.plans});
  }
  snapshot():Promise<PipelineState>{return this.load();}
  subscribe(listener:(state:PipelineState)=>void):()=>void{if(typeof listener!=='function')throw Error('A pipeline listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  start():Promise<PipelineState>{return this.options.store.withLock(async()=>{
    const loaded=await this.load();if(loaded.status==='passed')return loaded;
    if(loaded.status!=='idle')throw Error('This immutable pipeline already started; inspect its receipt or use its explicit pending action');
    const state=structuredClone(loaded);state.executionId=randomUUID();state.status='running';await this.persist(state);
    return this.advance(state,0,false);
  });}
  promote(request:PipelineActionRequest):Promise<PipelineState>{return this.options.store.withLock(async()=>{
    const state=structuredClone(await this.load()),index=this.admitAction(state,request,'promote');
    delete state.pendingAction;state.status='running';await this.persist(state);return this.advance(state,index,true);
  });}
  recover(request:PipelineActionRequest):Promise<PipelineState>{return this.options.store.withLock(async()=>{
    const state=structuredClone(await this.load()),index=this.admitAction(state,request,'recover');
    delete state.pendingAction;state.status='running';await this.persist(state);
    try{await this.options.targetStore.withLock(this.definition.stages[index]!.target,async()=>{
      const target=await this.options.targetStore.load(this.definition.stages[index]!.target);await this.checkBaseline(target);
      await this.execute(state,index,target,true,true);
    });}catch{this.markIncomplete(state,index);}
    state.status=state.stages[index]!.status==='incomplete'?'incomplete':'failed';
    state.error='The candidate was not promoted. Recovery outcomes and checks are retained.';await this.persist(state);return readPipelineState(state);
  });}
  private action(state:PipelineState,stageId:string,kind:'promote'|'recover'):PipelinePendingAction{
    return {kind,stageId,releaseDigest:this.release.digest,token:fingerprint({executionId:state.executionId,definitionDigest:this.definitionDigest,stageId,kind})};
  }
  private admitAction(state:PipelineState,input:PipelineActionRequest,kind:'promote'|'recover'):number{
    const request=object(input,['stageId','token','releaseDigest']);for(const key of ['stageId','token','releaseDigest'])text(request[key]);
    if(state.status!=='waiting'||!state.pendingAction||state.pendingAction.kind!==kind||canonical(request)!==canonical({stageId:state.pendingAction.stageId,token:state.pendingAction.token,releaseDigest:state.pendingAction.releaseDigest}))throw Error('Pipeline pending action changed; reload its exact staged release');
    return this.definition.stages.findIndex(stage=>stage.id===request.stageId);
  }
  private async advance(state:PipelineState,start:number,approved:boolean):Promise<PipelineState>{
    for(let index=start;index<this.definition.stages.length;index++){
      const definition=this.definition.stages[index]!,stage=state.stages[index]!;
      const gated=definition.promotion==='manual'&&!(approved&&index===start);
      try{
        await this.options.targetStore.withLock(definition.target,async()=>{
          const target=await this.options.targetStore.load(definition.target);await this.checkBaseline(target);
          await this.execute(state,index,target,!gated,false);
          if(stage.status==='failed'&&definition.rollback==='automatic'&&stage.baseline)await this.execute(state,index,target,true,true);
        });
      }catch{this.markIncomplete(state,index);}
      if(stage.status==='waiting'){
        state.status='waiting';state.pendingAction=this.action(state,stage.id,'promote');await this.persist(state);return readPipelineState(state);
      }
      if(stage.status!=='passed'){
        if(stage.status==='failed'&&definition.rollback==='manual'&&stage.baseline){state.status='waiting';state.pendingAction=this.action(state,stage.id,'recover');}
        else state.status=stage.status==='incomplete'?'incomplete':'failed';
        state.error=stage.status==='incomplete'?'The provider or recording outcome is uncertain. Inspect retained evidence before another attempt.':'A stage did not pass. Promotion stopped; its recovery policy and outcomes are retained.';
        await this.persist(state);return readPipelineState(state);
      }
    }
    state.status='passed';delete state.error;await this.persist(state);return readPipelineState(state);
  }
  private markIncomplete(state:PipelineState,index:number){const stage=state.stages[index]!;stage.status='incomplete';stage.phase='Inspect uncertain outcome';}
  private async load():Promise<PipelineState>{
    const state=await this.options.store.load()??{version:1,kind:'release-pipeline',definition:this.definition,definitionDigest:this.definitionDigest,release:this.release,executionId:null,status:'idle',
      stages:this.definition.stages.map(stage=>({id:stage.id,label:stage.label,status:'pending',phase:'Not started',operations:[]})),events:[],recordings:[]} as PipelineState;
    readReleaseManifest(state.release);
    if(state.definitionDigest!==this.definitionDigest||canonical(state.definition)!==canonical(this.definition)||canonical(state.release)!==canonical(this.release))throw Error('Pipeline release, stages, plan or host configuration changed; use a new immutable attempt');
    if(state.pendingAction&&canonical(state.pendingAction)!==canonical(this.action(state,state.pendingAction.stageId,state.pendingAction.kind)))throw Error('Pipeline pending action binding changed');
    for(const [index,receipt] of state.recordings.entries()){
      if(dirname(receipt.evidencePath)!==this.options.store.directory||dirname(receipt.tracePath)!==this.options.store.directory)throw Error('Pipeline receipt left its bound store');
      let loaded:Awaited<ReturnType<typeof loadPipelineRecording>>;
      try{loaded=await loadPipelineRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:this.definitionDigest,executionId:state.executionId!,stageId:receipt.stageId});}
      catch(error){if(receipt.status==='incomplete'&&state.stages.find(stage=>stage.id===receipt.stageId)?.status==='incomplete')continue;throw error;}
      const shared=(loaded.snapshot as {sharedState?:Record<string,unknown>}).sharedState,stage=state.stages.find(stage=>stage.id===receipt.stageId)!;
      const compiled=this.plans.find(item=>item.stageId===receipt.stageId)!;
      const recorded=shared?.stage as {operations?:unknown[]}|undefined;
      if(!shared||shared.definitionDigest!==this.definitionDigest||canonical(shared.definition)!==canonical(recordedPipelineDefinition(this.definition,this.release,receipt.stageId,compiled.plan))||!recorded||!Array.isArray(recorded.operations)
        ||canonical(recorded.operations)!==canonical(stage.operations.slice(0,recorded.operations.length).map(recordedOperation)))throw Error('Pipeline receipts differ from retained native recording');
      const latest=state.recordings.findLastIndex(item=>item.stageId===receipt.stageId)===index;
      if(latest&&!['running','incomplete'].includes(stage.status)&&canonical(shared.stage)!==canonical(recordedStage(stage)))throw Error('Pipeline stage outcome differs from retained native recording');
      if(receipt.status!==loaded.status)throw Error('Pipeline recording status changed');
    }
    return readPipelineState(state);
  }
  private async checkBaseline(target:PipelineTargetState):Promise<void>{
    if(!target.lastVerified)return;
    const verified=target.lastVerified;readReleaseManifest(verified.release);
    const loaded=await loadPipelineRecording(verified.recording.evidencePath,{runId:verified.recording.runId,stageId:verified.recording.stageId});
    const shared=(loaded.snapshot as {sharedState?:{stage?:PipelineStageState;definition?:{targetId?:string;targetDigest?:string}}}).sharedState,stage=shared?.stage;
    if(shared?.definition?.targetId!==target.target.id||shared.definition.targetDigest!==fingerprint(target.target)||loaded.status!=='passed'||!stage||!['passed','rolled-back'].includes(stage.status)||stage.lastVerified!==verified.release.digest||stage.lastApplied!==verified.release.digest)throw Error('Verified baseline does not match retained native evidence');
  }
  private async persist(state:PipelineState){await this.options.store.save(state);this.publish(state);}
  private publish(state:PipelineState){const value=readPipelineState(state);for(const listener of this.listeners)try{listener(value);}catch{/* A view cannot change release execution. */}}
  private async execute(state:PipelineState,index:number,target:PipelineTargetState,approved:boolean,recovery:boolean):Promise<void>{
    const stage=this.definition.stages[index]!,stageState=state.stages[index]!,store=this.options.store;
    const config:PipelineStages={definition:this.definition,definitionDigest:this.definitionDigest,release:this.release,state,stage,plan:this.plans[index]!.plan,
      adapter:this.registry.adapters.find(adapter=>adapter.id===stage.adapterId)!,checks:new Map(this.registry.checks.map(runner=>[runner.id,runner])),target,approved,recovery,blocked:false,uncertain:false,
      persist:async()=>{try{await this.persist(state);}catch{throw Error('Pipeline durable state could not be saved; inspect the retained operation intent');}},persistTarget:async()=>{try{await this.options.targetStore.save(target);}catch{throw Error('Pipeline target state could not be saved; inspect the retained operation intent');}}};
    const identity=randomUUID(),evidencePath=join(store.directory,identity+'.json'),tracePath=join(store.directory,identity+'.jsonl');
    const chart=recovery?createPipelineRecoveryChart(config):createPipelineStageChart(config),control=controlDepRecorder({id:'iac-pipeline-control'});
    const progress:CombinedRecorder={id:'iac-pipeline-progress',onEmit:event=>this.recordEvent(state,event),toSnapshot:()=>({name:'Release pipeline',data:{events:state.events},description:'Measured rollout, acceptance and recovery outcomes.'})};
    let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,captureFailed=false,failed=false;
    try{
      sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});
      executor.enableNarrative();executor.attachCombinedRecorder(control);executor.attachCombinedRecorder(progress);
      for(const recorder of this.options.recorders??[])executor.attachCombinedRecorder(recorder);
      await executor.run();
    }catch{failed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
    if(!executor){this.markIncomplete(state,index);await this.persist(state);return;}
    const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};
    if(!snapshot.runId){this.markIncomplete(state,index);await this.persist(state);return;}
    for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const entry=control.asLookup()(commit.runtimeStageId);if(entry)controlDeps[commit.runtimeStageId]=entry;}
    captureFailed||=(snapshot.sink?.failed??0)>0;
    let status:'passed'|'failed'|'incomplete'=failed||captureFailed||stageState.status==='running'||stageState.status==='incomplete'?'incomplete':stageState.status==='failed'?'failed':'passed';
    try{
      await store.writeJson(evidencePath,{version:1,kind:'pipeline-native-evidence',runId:snapshot.runId,definitionDigest:this.definitionDigest,executionId:state.executionId,stageId:stage.id,
        snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,
        traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},status,
        limitations:['Adapter internals and private metadata are not recorded here. Continuation segments reference prior native run IDs; no cross-run causal edge is invented. Restoring an application release does not restore or reverse persistent data.']});
    }catch{captureFailed=true;status='incomplete';}
    const receipt={runId:snapshot.runId!,evidencePath,tracePath,status,stageId:stage.id,kind:recovery?'recovery' as const:'rollout' as const};state.recordings.push(receipt);
    if(status==='incomplete'){
      this.markIncomplete(state,index);
      if(stageState.lastVerified===this.release.digest) {if(stageState.baseline)stageState.lastVerified=stageState.baseline.release.digest;else delete stageState.lastVerified;}
    }else if(stageState.status==='passed'||stageState.status==='rolled-back'){
      const verifiedRelease=recovery?stageState.baseline!.release:this.release;
      target.lastVerified={release:verifiedRelease,verifiedAt:Date.now(),recording:receipt};await this.options.targetStore.save(target);
    }
    await this.persist(state);
  }
  private recordEvent(state:PipelineState,event:EmitEvent){
    if(event.name!==PIPELINE_EVENT)return;
    const item=event.payload as {executionId?:string;stageId?:string;phase?:string;status?:string};
    if(item.executionId!==state.executionId||!this.definition.stages.some(stage=>stage.id===item.stageId)||typeof item.phase!=='string'||!['running','passed','failed','incomplete','rolled-back'].includes(item.status??''))return;
    state.events.push({sequence:state.events.length+1,executionId:state.executionId!,stageId:item.stageId!,phase:item.phase,status:item.status as 'running'|'passed'|'failed'|'incomplete'|'rolled-back',timestamp:event.timestamp,runtimeStageId:event.runtimeStageId});
  }
}
