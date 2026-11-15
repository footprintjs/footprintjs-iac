import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {FlowChartExecutor} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {identifier} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import type {PipelineActionRequest,PipelineState} from '../pipeline/types.ts';
import {readReleaseAutomationDefinition,readReleaseAutomationState} from './data.ts';
import {FileReleaseAutomationStore} from './store.ts';
import {latestPublishedReleaseStrategy,projectReleaseAutomationAttempt} from './project.ts';
import {createReleaseDiscoveryChart} from './create-discovery-chart.ts';
import {createReleaseSelectionChart} from './create-selection-chart.ts';
import {createReleaseAutomationChart} from './create-attempt-chart.ts';
import {createReleaseContinuationChart} from './create-continuation-chart.ts';
import {loadReleaseAutomationRecording} from './recording.ts';
import {verifiedPreparation,verifiedPipeline} from './verify.ts';
import {releaseSourceDigest} from './source.ts';
import type {AutomationStages} from './stages.ts';
import type {ReleaseAutomationAttempt,ReleaseAutomationContext,ReleaseAutomationOptions,ReleaseAutomationPort,ReleaseAutomationState} from './types.ts';

export interface ReleaseAutomationHostOptions extends ReleaseAutomationOptions {store:FileReleaseAutomationStore}
/** Finite, explicit host calls. Constructing this class starts no poller, build or deployment. */
export class ReleaseAutomationHost implements ReleaseAutomationPort {
  private readonly options:ReleaseAutomationHostOptions;private readonly definition;private readonly digest:string;private readonly strategy;private readonly clock:()=>number;
  private readonly listeners=new Set<(state:ReleaseAutomationState)=>void>();
  private readonly activeAttempts=new Set<string>();
  constructor(options:ReleaseAutomationHostOptions){
    this.definition=readReleaseAutomationDefinition(options.definition);const strategy=options.strategy??latestPublishedReleaseStrategy();identifier(strategy.id,'release strategy');
    this.strategy={id:strategy.id,select:strategy.select.bind(strategy)};
    if(options.catalog.id!==this.definition.catalogId||options.adapter.id!==this.definition.adapterId||typeof options.catalog.list!=='function'||typeof options.catalog.resolve!=='function'||typeof options.adapter.prepare!=='function'||typeof options.adapter.pipeline!=='function'||typeof this.strategy.select!=='function')throw Error('Register exact release catalog, adapter and selection strategy');
    this.options={...options,catalog:{id:options.catalog.id,list:options.catalog.list.bind(options.catalog),resolve:options.catalog.resolve.bind(options.catalog)},adapter:{id:options.adapter.id,prepare:options.adapter.prepare.bind(options.adapter),pipeline:options.adapter.pipeline.bind(options.adapter)}};
    this.digest=fingerprint({definition:this.definition,strategyId:this.strategy.id});this.clock=options.clock??Date.now;
  }
  subscribe(listener:(state:ReleaseAutomationState)=>void):()=>void{if(typeof listener!=='function')throw Error('A release listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async snapshot():Promise<ReleaseAutomationState>{
    const state=await this.load();
    for(const receipt of state.recordings){if(dirname(receipt.evidencePath)!==this.options.store.directory||dirname(receipt.tracePath)!==this.options.store.directory)throw Error('Automation capture left its store');
      try{const loaded=await loadReleaseAutomationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:this.digest,...(receipt.attemptId?{attemptId:receipt.attemptId}:{})});if(loaded.complete!==receipt.complete)throw Error('Automation capture changed');}catch(error){if(receipt.complete)throw error;}}
    for(const attempt of state.attempts){
      if(attempt.recordings.some(receipt=>receipt.attemptId!==attempt.id||!state.recordings.some(global=>canonical(global)===canonical(receipt))))throw Error('Attempt recording left its automation history');
      if(attempt.source&&releaseSourceDigest(attempt.source.source)!==attempt.sourceDigest)throw Error('Pinned automation source changed');
      if(attempt.preparation&&attempt.source)await verifiedPreparation(attempt.preparation,attempt.source);
      if(attempt.pipeline&&attempt.preparation)await verifiedPipeline(attempt.pipeline,attempt.preparation);
      if(attempt.status==='passed'&&(!attempt.source||attempt.preparation?.status!=='passed'||attempt.pipeline?.status!=='passed'))throw Error('Release success lacks its verified children');
      if(attempt.status==='waiting'&&(!attempt.source||attempt.preparation?.status!=='passed'||attempt.pipeline?.status!=='waiting'||!attempt.pipeline.pendingAction))throw Error('Release gate lacks its exact pipeline');
      if(attempt.status==='skipped'&&(!attempt.duplicateOf||!attempt.sourceDigest||!state.attempts.some(other=>other.id===attempt.duplicateOf&&other.sourceDigest===attempt.sourceDigest)))throw Error('Duplicate release source is not established');
      const receipt=attempt.recordings.at(-1);if(!this.activeAttempts.has(attempt.id)&&receipt?.complete&&['passed','failed','waiting','skipped'].includes(attempt.status)){
        const loaded=await loadReleaseAutomationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:this.digest,attemptId:attempt.id});
        const shared=(loaded.snapshot as {sharedState?:Record<string,unknown>}).sharedState;
        // Receipts are appended after capture, so their public IDs are not part of the recorded outcome.
        const expected=projectReleaseAutomationAttempt(attempt);expected.recordings=expected.recordings.slice(0,-1);
        if(canonical(shared?.outcome)!==canonical(expected))throw Error('Automation outcome differs from its native capture');
      }
    }
    for(const attempt of state.attempts)if(!this.activeAttempts.has(attempt.id)&&(['reserved','resolving','preparing','deploying'].includes(attempt.status)||['passed','failed','waiting','skipped'].includes(attempt.status)&&attempt.recordings.at(-1)?.complete!==true)){attempt.status='incomplete';attempt.reason='host-operation-not-active';}
    return state;
  }
  refresh():Promise<ReleaseAutomationState>{return this.options.store.withLock(async()=>{const state=await this.snapshot();await this.discover(state);return readReleaseAutomationState(state);});}
  tick():Promise<ReleaseAutomationState>{return this.options.store.withLock(async()=>{
    const state=await this.snapshot();await this.discover(state);if(state.discoveryStatus!=='available')return state;
    if(!state.initialized){state.initialized=true;if(this.definition.automatic.initial==='observe'){state.seenIds=[...new Set([...state.seenIds,...state.choices.map(choice=>choice.id)])];await this.persist(state);return readReleaseAutomationState(state);}}
    if(!this.definition.automatic.enabled||this.blocker(state,true)){await this.persist(state);return readReleaseAutomationState(state);}
    const eligible=state.choices.filter(choice=>!state.seenIds.includes(choice.id)&&!state.attempts.some(attempt=>attempt.releaseId===choice.id)).map(choice=>choice.id);
    let selected:string|undefined;const config=this.config(state);
    const complete=await this.capture(state,createReleaseSelectionChart(config,this.strategy,eligible,id=>{selected=id;}));
    if(complete&&selected){state.seenIds=[...new Set([...state.seenIds,...state.choices.map(choice=>choice.id)])];await this.reserve(state,selected,'automatic');}
    else await this.persist(state);return readReleaseAutomationState(state);
  });}
  start(releaseId:string):Promise<ReleaseAutomationState>{identifier(releaseId,'release choice');return this.options.store.withLock(async()=>{
    const state=await this.snapshot();if(!state.choices.some(choice=>choice.id===releaseId)||state.discoveryStatus!=='available')throw Error('Refresh and choose a discovered release ID');
    if(state.attempts.some(attempt=>attempt.releaseId===releaseId))return state;if(this.blocker(state,false))throw Error('An existing release is active, gated or uncertain; inspect it first');
    await this.reserve(state,releaseId,'manual');return readReleaseAutomationState(state);
  });}
  promote(attemptId:string,request:PipelineActionRequest):Promise<ReleaseAutomationState>{return this.continue(attemptId,request,'promote');}
  recover(attemptId:string,request:PipelineActionRequest):Promise<ReleaseAutomationState>{return this.continue(attemptId,request,'recover');}
  private continue(id:string,request:PipelineActionRequest,kind:'promote'|'recover'):Promise<ReleaseAutomationState>{identifier(id,'automation attempt');return this.options.store.withLock(async()=>{
    const state=await this.snapshot(),attempt=state.attempts.find(item=>item.id===id);if(!attempt?.preparation||!attempt.pipeline||attempt.status!=='waiting'||attempt.pipeline.pendingAction?.kind!==kind)throw Error('Choose the outstanding release gate');
    const pending=attempt.pipeline.pendingAction;if(canonical(request)!==canonical({stageId:pending.stageId,token:pending.token,releaseDigest:pending.releaseDigest}))throw Error('The pipeline gate changed; reload it');
    const config=this.config(state,attempt);this.activeAttempts.add(attempt.id);try{await this.capture(state,createReleaseContinuationChart(config,async()=>{
      attempt.status='deploying';await this.persist(state);try{const workflow=await this.options.adapter.pipeline(attempt.preparation!,this.context(attempt));
        const current=await workflow.snapshot();if(canonical(current)!==canonical(attempt.pipeline))throw Error('The retained pipeline changed');
        const unsubscribe=workflow.subscribe(value=>{attempt.pipeline=value;this.publish(state);});
        try{attempt.pipeline=await verifiedPipeline(await workflow[kind](request),attempt.preparation!);this.pipelineStatus(attempt);}finally{unsubscribe();}
      }catch{attempt.status='incomplete';attempt.reason='pipeline-continuation-unconfirmed';}await this.persist(state);
    }),attempt);}finally{this.activeAttempts.delete(attempt.id);}return readReleaseAutomationState(state);
  });}
  private async reserve(state:ReleaseAutomationState,id:string,trigger:'manual'|'automatic'){
    if(state.attempts.length>=256)throw Error('Archive release automation history before another attempt');
    const attempt:ReleaseAutomationAttempt={id:randomUUID(),releaseId:id,trigger,status:'reserved',createdAt:this.now(),recordings:[]};state.attempts.push(attempt);
    state.seenIds=[...new Set([...state.seenIds,id])];await this.persist(state);
    const config=this.config(state,attempt);this.activeAttempts.add(attempt.id);try{await this.capture(state,createReleaseAutomationChart(config),attempt);}finally{this.activeAttempts.delete(attempt.id);}
  }
  private config(state:ReleaseAutomationState,attempt?:ReleaseAutomationAttempt):AutomationStages{return{state,catalog:this.options.catalog,...(attempt?{attempt}:{}),persist:()=>this.persist(state),prepare:()=>this.prepare(state,attempt!),launch:()=>this.launch(state,attempt!)};}
  private async prepare(state:ReleaseAutomationState,attempt:ReleaseAutomationAttempt){
    try{const workflow=await this.options.adapter.prepare(attempt.source!,this.context(attempt));
      const initial=await verifiedPreparation(await workflow.snapshot(),attempt.source!);if(initial.status!=='idle')throw Error('A new source build must start from its immutable idle attempt');
      const unsubscribe=workflow.subscribe(value=>{attempt.preparation=value;this.publish(state);});
      try{attempt.preparation=await verifiedPreparation(await workflow.start(),attempt.source!);}finally{unsubscribe();}
      if(attempt.preparation.status!=='passed'){attempt.status=attempt.preparation.status==='failed'?'failed':'incomplete';attempt.reason='release-build-did-not-pass';}
    }catch{attempt.status='incomplete';attempt.reason='release-build-unconfirmed';}await this.persist(state);
  }
  private async launch(state:ReleaseAutomationState,attempt:ReleaseAutomationAttempt){
    try{const workflow=await this.options.adapter.pipeline(attempt.preparation!,this.context(attempt));const initial=await verifiedPipeline(await workflow.snapshot(),attempt.preparation!);
      if(initial.status!=='idle')throw Error('A new release pipeline must have its own idle attempt');
      const unsubscribe=workflow.subscribe(value=>{attempt.pipeline=value;this.publish(state);});
      try{attempt.pipeline=await verifiedPipeline(await workflow.start(),attempt.preparation!);this.pipelineStatus(attempt);}finally{unsubscribe();}
    }catch{attempt.status='incomplete';attempt.reason='pipeline-start-unconfirmed';}await this.persist(state);
  }
  private pipelineStatus(attempt:ReleaseAutomationAttempt){const status=attempt.pipeline!.status;attempt.status=status==='passed'||status==='failed'||status==='waiting'?status:'incomplete';if(status==='failed'||status==='incomplete')attempt.reason='pipeline-did-not-pass';else delete attempt.reason;}
  private context(attempt:ReleaseAutomationAttempt):ReleaseAutomationContext{return{attemptId:attempt.id,definitionDigest:this.digest,directory:this.options.store.attemptDirectory(attempt.id)};}
  private blocker(state:ReleaseAutomationState,automatic:boolean){const last=state.attempts.findLast(attempt=>attempt.status!=='skipped');return state.attempts.some(attempt=>['reserved','resolving','preparing','deploying','waiting','incomplete'].includes(attempt.status))||automatic&&last?.status==='failed';}
  private now(){const value=this.clock();if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid automation clock');return value;}
  private async discover(state:ReleaseAutomationState){state.lastRefreshAt=this.now();await this.capture(state,createReleaseDiscoveryChart(this.config(state)));}
  private async load():Promise<ReleaseAutomationState>{const state=await this.options.store.load()??{version:1,kind:'release-automation',definition:this.definition,definitionDigest:this.digest,initialized:false,choices:[],seenIds:[],attempts:[],recordings:[],discoveryStatus:'not-checked'} as ReleaseAutomationState;
    if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('Release automation host policy changed; use a new bound store');return readReleaseAutomationState(state);}
  private publish(state:ReleaseAutomationState){const copy=readReleaseAutomationState(state);for(const listener of this.listeners)try{listener(copy);}catch{/* View failures do not control deployment. */}}
  private async persist(state:ReleaseAutomationState){await this.options.store.save(state);this.publish(state);}
  private async capture(state:ReleaseAutomationState,chart:ReturnType<typeof createReleaseDiscoveryChart>,attempt?:ReleaseAutomationAttempt):Promise<boolean>{
    if(state.recordings.length>=1000||(attempt?.recordings.length??0)>=32)throw Error('Archive bounded release automation history before more work');
    const id=randomUUID(),evidencePath=join(this.options.store.directory,id+'.json'),tracePath=join(this.options.store.directory,id+'.jsonl');const control=controlDepRecorder({id:'iac-release-automation-control'});
    let executor:FlowChartExecutor|undefined,sink:ReturnType<typeof fileSink>|undefined,failed=false;
    try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.attachCombinedRecorder(control);executor.enableNarrative();await executor.run();}
    catch{failed=true;}finally{if(sink)try{await sink.close();}catch{failed=true;}}
    if(!executor){if(attempt){attempt.status='incomplete';attempt.reason='automation-capture-unavailable';}await this.persist(state);return false;}
    const snapshot=executor.getSnapshot(),complete=!failed&&(snapshot.sink?.failed??0)===0,controlDeps:Record<string,unknown>={};
    for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const value=control.asLookup()(commit.runtimeStageId);if(value)controlDeps[commit.runtimeStageId]=value;}
    let saved=complete;try{await this.options.store.writeJson(evidencePath,{version:1,kind:'release-automation-native-evidence',runId:snapshot.runId,definitionDigest:this.digest,...(attempt?{attemptId:attempt.id}:{}),snapshot,structure:chart.buildTimeStructure,controlDeps,narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(failed?1:0),flushed:!failed},complete});}catch{saved=false;}
    const receipt={runId:snapshot.runId!,evidencePath,tracePath,complete:saved,...(attempt?{attemptId:attempt.id}:{})};state.recordings.push(receipt);attempt?.recordings.push(receipt);
    if(!saved&&attempt){attempt.status='incomplete';attempt.reason='automation-capture-unconfirmed';}await this.persist(state);return saved;
  }
}
