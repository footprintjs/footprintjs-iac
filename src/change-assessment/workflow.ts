import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder,type EmitEvent} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {identifier} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {readAssessmentDefinition} from './data.ts';
import {createChangeAssessmentChart} from './create-assessment-chart.ts';
import {loadChangeAssessmentRecording} from './recording.ts';
import {recordedAssessmentDefinition} from './project.ts';
import {FileChangeAssessmentStore} from './store.ts';
import {readChangeAssessmentState} from './state.ts';
import {CHANGE_ASSESSMENT_EVENT,type ChangeAssessmentDefinition,type ChangeAssessmentRegistry,type ChangeAssessmentState,type ChangeAssessmentWorkflowPort} from './types.ts';

export interface ChangeAssessmentWorkflowOptions{definition:ChangeAssessmentDefinition;registry:ChangeAssessmentRegistry;store:FileChangeAssessmentStore;recorders?:readonly CombinedRecorder[]}
function bindRegistry(input:ChangeAssessmentRegistry,definition:ChangeAssessmentDefinition):ChangeAssessmentRegistry{
  if(!input||!Array.isArray(input.adapters)||!Array.isArray(input.strategies)||input.adapters.length>128||input.strategies.length>128)throw Error('Register bounded assessment adapters and strategies');
  const adapters=input.adapters.map(adapter=>{identifier(adapter.id,'assessment adapter');identifier(adapter.provider,'assessment provider');
    if(typeof adapter.scope!=='string'||typeof adapter.probe!=='function')throw Error('Configure scoped read-only provider probe');return{id:adapter.id,provider:adapter.provider,scope:adapter.scope,probe:adapter.probe.bind(adapter)};});
  const strategies=input.strategies.map(strategy=>{identifier(strategy.id,'assessment strategy');if(typeof strategy.classify!=='function')throw Error('Configure pure assessment strategy');return{id:strategy.id,label:strategy.label,classify:strategy.classify.bind(strategy)};});
  if(new Set(adapters.map(adapter=>adapter.id)).size!==adapters.length||new Set(strategies.map(strategy=>strategy.id)).size!==strategies.length)throw Error('Duplicate assessment registration');
  for(const change of definition.changes){const adapter=adapters.find(adapter=>adapter.id===change.adapterId);
    if(!adapter||adapter.scope!==definition.target.scope||[change.previous,change.desired].some(resource=>resource&&resource.provider!==adapter.provider)
      ||!strategies.some(strategy=>strategy.id===change.strategyId))throw Error('Change assessment requires a registered provider, strategy and exact target scope');}
  return{adapters,strategies};
}
/** An immutable point-in-time, read-only attempt. A report never authorizes later resource deletion. */
export class ChangeAssessmentWorkflow implements ChangeAssessmentWorkflowPort{
  private readonly definition:ChangeAssessmentDefinition;private readonly digest:string;private readonly registry:ChangeAssessmentRegistry;private readonly options:ChangeAssessmentWorkflowOptions;
  private readonly listeners=new Set<(state:ChangeAssessmentState)=>void>();
  constructor(options:ChangeAssessmentWorkflowOptions){this.options={...options};this.definition=readAssessmentDefinition(options.definition);this.digest=fingerprint(this.definition);this.registry=bindRegistry(options.registry,this.definition);}
  subscribe(listener:(state:ChangeAssessmentState)=>void):()=>void{if(typeof listener!=='function')throw Error('An assessment listener must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async snapshot():Promise<ChangeAssessmentState>{
    const state=await this.options.store.load()??{version:1,kind:'change-assessment-state',definition:this.definition,definitionDigest:this.digest,executionId:null,status:'idle',events:[],decisions:[]} as ChangeAssessmentState;
    if(state.definitionDigest!==this.digest||canonical(state.definition)!==canonical(this.definition))throw Error('Assessment target, source or desired resource changed; use a new attempt');
    if(state.status==='complete'){
      const receipt=state.recording!;if(dirname(receipt.evidencePath)!==this.options.store.directory||dirname(receipt.tracePath)!==this.options.store.directory||receipt.tracePath!==receipt.evidencePath.replace(/\.json$/,'.jsonl'))throw Error('Assessment receipt left its native store binding');
      const recorded=await loadChangeAssessmentRecording(receipt.evidencePath,{runId:receipt.runId,executionId:state.executionId!,definitionDigest:this.digest});
      const shared=(recorded.snapshot as {sharedState?:Record<string,unknown>}).sharedState;
      if(!recorded.complete||!shared||canonical(shared.definition)!==canonical(recordedAssessmentDefinition(this.definition))||canonical(shared.report)!==canonical(state.report))throw Error('Assessment report differs from native recording');
    }
    return readChangeAssessmentState(state);
  }
  start():Promise<ChangeAssessmentState>{return this.options.store.withLock(async()=>{
    const state=structuredClone(await this.snapshot());if(state.status==='complete')return state;
    if(state.status!=='idle')throw Error('This assessment already started; inspect its capture before a new explicit attempt');
    state.executionId=randomUUID();state.status='running';await this.persist(state);return this.run(state);
  });}
  private async persist(state:ChangeAssessmentState){await this.options.store.save(state);const copy=readChangeAssessmentState(state);for(const listener of this.listeners)try{listener(copy);}catch{/* A viewer cannot control provider observation. */}}
  private async run(state:ChangeAssessmentState):Promise<ChangeAssessmentState>{
    const store=this.options.store,id=randomUUID(),evidencePath=join(store.directory,id+'.json'),tracePath=join(store.directory,id+'.jsonl');
    const chart=createChangeAssessmentChart({definition:this.definition,state,registry:this.registry,persist:()=>this.persist(state)}),control=controlDepRecorder({id:'iac-assessment-control'});
    const progress:CombinedRecorder={id:'iac-assessment-progress',onEmit:event=>this.event(state,event),toSnapshot:()=>({name:'Change assessment',data:{events:state.events},description:'Read-only measured capability and ownership checks.'})};
    let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,failed=false;
    try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});
      executor.enableNarrative();executor.attachCombinedRecorder(control);executor.attachCombinedRecorder(progress);for(const recorder of this.options.recorders??[])executor.attachCombinedRecorder(recorder);await executor.run();
    }catch{failed=true;}finally{if(sink)try{await sink.close();}catch{failed=true;}}
    if(!executor){state.status='incomplete';state.error='Native assessment could not start; no provider probe was invoked.';await this.persist(state);return readChangeAssessmentState(state);}
    const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const entry=control.asLookup()(commit.runtimeStageId);if(entry)controlDeps[commit.runtimeStageId]=entry;}
    const complete=!failed&&(snapshot.sink?.failed??0)===0&&!!state.report&&state.decisions.length===this.definition.changes.length;
    try{await store.writeJson(evidencePath,{version:1,kind:'change-assessment-native-evidence',runId:snapshot.runId,executionId:state.executionId,definitionDigest:this.digest,
      snapshot,structure:chart.buildTimeStructure,controlDeps,narrative:executor.getNarrativeEntries(),decisions:control.getDecisions(),tracePath,
      traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(failed?1:0),flushed:!failed},complete});
    }catch{failed=true;}
    state.status=complete&&!failed?'complete':'incomplete';state.recording={runId:snapshot.runId!,evidencePath,tracePath,complete:state.status==='complete'};
    if(state.status!=='complete'){delete state.report;state.error='Assessment recording is incomplete; no replacement or update is authorized.';}
    await this.persist(state);return readChangeAssessmentState(state);
  }
  private event(state:ChangeAssessmentState,event:EmitEvent){if(event.name!==CHANGE_ASSESSMENT_EVENT)return;const value=event.payload as {executionId?:string;changeId?:string;status?:string};
    if(value.executionId!==state.executionId||!this.definition.changes.some(change=>change.id===value.changeId)||!['checking','checked'].includes(value.status??''))return;
    state.events.push({sequence:state.events.length+1,executionId:state.executionId!,changeId:value.changeId!,status:value.status as 'checking'|'checked',timestamp:event.timestamp,runtimeStageId:event.runtimeStageId});
  }
}
