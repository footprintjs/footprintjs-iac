import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { FlowChartExecutor,type CombinedRecorder,type EmitEvent } from 'footprintjs';
import { fileSink } from 'footprintjs/sinks';
import { controlDepRecorder } from 'footprintjs/trace';
import type { ChangeAssessmentReport } from '../change-assessment/types.ts';
import { readChangeAssessmentReport } from '../change-assessment/report.ts';
import { canonical,fingerprint } from '../util.ts';
import { compileMigrationPlan } from './compile.ts';
import { object,readMigrationDefinition,readMigrationState } from './data.ts';
import { createMigrationPrepareChart } from './create-prepare-chart.ts';
import { createMigrationCutoverChart } from './create-cutover-chart.ts';
import { createMigrationRecoveryChart } from './create-recovery-chart.ts';
import { loadMigrationRecording } from './recording.ts';
import { recordedMigrationDefinition,recordedMigrationOperation,recordedMigrationState } from './summary.ts';
import { FileMigrationStore,FileMigrationLocks } from './store.ts';
import { MIGRATION_EVENT,type MigrationStages } from './stages.ts';
import type { MigrationActionRequest,MigrationDefinition,MigrationRegistry,MigrationPlan,MigrationState,MigrationWorkflowPort } from './types.ts';
export interface MigrationWorkflowOptions {assessment?:ChangeAssessmentReport;definition:MigrationDefinition;registry:MigrationRegistry;store:FileMigrationStore;locks:FileMigrationLocks;recorders?:readonly CombinedRecorder[]}
/** Explicit stateful replacement. No deletion API, automatic rollback or unknown-effect retry. */
export class MigrationWorkflow implements MigrationWorkflowPort {
 private readonly options:MigrationWorkflowOptions;private readonly definition:MigrationDefinition;private readonly plan:MigrationPlan;private readonly definitionDigest:string;private readonly adapter:MigrationRegistry['adapters'][number];
 private readonly listeners=new Set<(state:MigrationState)=>void>();
 constructor(options:MigrationWorkflowOptions){this.options=options;this.definition=readMigrationDefinition(options.definition);
  if(options.assessment){const report=readChangeAssessmentReport(options.assessment),change=report.changes.find(value=>value.id===this.definition.changeId);if(report.digest!==this.definition.assessmentDigest||report.target.scopeDigest!==fingerprint(this.definition.source.scope)||!change||change.disposition!=='replace'||change.data==='unknown')throw Error('Migration assessment does not match this declared replacement binding');}
  this.plan=compileMigrationPlan(this.definition,options.registry);this.definitionDigest=fingerprint({definition:this.definition,plan:this.plan,assessmentBinding:options.assessment?'supplied-report':'host-declared'});const adapter=options.registry.adapters.find(value=>value.id===this.definition.adapterId)!;this.adapter={id:adapter.id,label:adapter.label,capabilities:Object.freeze([...adapter.capabilities]),execute:adapter.execute.bind(adapter),observe:adapter.observe.bind(adapter)};}
 snapshot():Promise<MigrationState>{return this.load();}
 subscribe(listener:(state:MigrationState)=>void):()=>void{if(typeof listener!=='function')throw Error('A migration subscriber must be callable');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 start():Promise<MigrationState>{return this.options.store.withLock(()=>this.options.locks.withLock(this.definition,async()=>{
  const state=structuredClone(await this.load());if(state.status==='passed'||state.status==='recovered')return state;if(state.status!=='idle')throw Error('This immutable migration already started; inspect its retained outcome or exact pending action');state.executionId=randomUUID();state.status='running';await this.persist(state);return this.execute(state,'prepare');
 }));}
 cutover(request:MigrationActionRequest):Promise<MigrationState>{return this.continue(request,'cutover');}
 recover(request:MigrationActionRequest):Promise<MigrationState>{return this.continue(request,'recover');}
 private continue(input:MigrationActionRequest,kind:'cutover'|'recover'):Promise<MigrationState>{return this.options.store.withLock(()=>this.options.locks.withLock(this.definition,async()=>{
  const state=structuredClone(await this.load()),request=object(input,['executionId','token','checkpointDigest']);
  if(state.status!=='waiting'||state.pendingAction?.kind!==kind||canonical(request)!==canonical(this.action(state,kind)))throw Error('Migration pending action changed or is not safe to execute');
  delete state.pendingAction;state.status='running';await this.persist(state);return this.execute(state,kind==='cutover'?'cutover':'recovery');
 }));}
 private action(state:MigrationState,kind:'cutover'|'recover'|'inspect'):MigrationActionRequest{const checkpointDigest=fingerprint(state.checkpoint);return {executionId:state.executionId!,checkpointDigest,token:fingerprint({executionId:state.executionId,definitionDigest:this.definitionDigest,checkpointDigest,kind})};}
 private async load():Promise<MigrationState>{
  const state=await this.options.store.load()??{version:1,kind:'stateful-migration',definition:this.definition,definitionDigest:this.definitionDigest,executionId:null,status:'idle',checkpoint:{},operations:[],events:[],recordings:[]} as MigrationState;
  if(state.definitionDigest!==this.definitionDigest||canonical(state.definition)!==canonical(this.definition))throw Error('Migration assessment, source, target, strategy or host configuration changed');
  if(state.pendingAction&&canonical(state.pendingAction)!==canonical({...this.action(state,state.pendingAction.kind),kind:state.pendingAction.kind}))throw Error('Migration pending action binding changed');
  for(const[index,receipt]of state.recordings.entries()){
   if(dirname(receipt.evidencePath)!==this.options.store.directory||dirname(receipt.tracePath)!==this.options.store.directory||receipt.tracePath!==receipt.evidencePath.replace(/\.json$/,'.jsonl'))throw Error('Migration receipt left its bound store');
   let loaded:Awaited<ReturnType<typeof loadMigrationRecording>>;try{loaded=await loadMigrationRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:this.definitionDigest,executionId:state.executionId!});}catch(error){if(receipt.status==='incomplete'&&state.status==='incomplete')continue;throw error;}
   const shared=(loaded.snapshot as {sharedState?:Record<string,unknown>}).sharedState,summary=shared?.summary as {operations?:unknown[]}|undefined;
   if(loaded.status!==receipt.status||(shared?.continuation as {segment?:string}|undefined)?.segment!==receipt.kind||canonical(shared?.definition)!==canonical(recordedMigrationDefinition(this.definition,this.plan))||!Array.isArray(summary?.operations)||canonical(summary.operations)!==canonical(state.operations.slice(0,summary.operations.length).map(recordedMigrationOperation)))throw Error('Migration receipts differ from native execution');
   if(index===state.recordings.length-1&&!['running','incomplete'].includes(state.status)&&canonical(summary)!==canonical(recordedMigrationState(state)))throw Error('Migration checkpoint differs from native execution');
  }
  if(['passed','recovered','waiting'].includes(state.status)&&!state.recordings.length)throw Error('Migration outcome lacks its native recording');
  return readMigrationState(state);
 }
 private async persist(state:MigrationState){await this.options.store.save(state);const value=readMigrationState(state);for(const listener of this.listeners)try{listener(value);}catch{/* Views cannot alter migration execution. */}}
 private async execute(state:MigrationState,segment:'prepare'|'cutover'|'recovery'):Promise<MigrationState>{
  const config:MigrationStages={state,plan:this.plan,adapter:this.adapter,segment,blocked:false,uncertain:false,persist:async()=>{if(state.status==='running')await this.persist(state);else{const interim=structuredClone(state);interim.status='running';delete interim.pendingAction;await this.persist(interim);}},action:kind=>this.action(state,kind)};
  const chart=segment==='prepare'?createMigrationPrepareChart(config):segment==='cutover'?createMigrationCutoverChart(config):createMigrationRecoveryChart(config);
  const id=randomUUID(),store=this.options.store,evidencePath=join(store.directory,id+'.json'),tracePath=join(store.directory,id+'.jsonl'),control=controlDepRecorder({id:'iac-migration-control'});
  const progress:CombinedRecorder={id:'iac-migration-progress',onEmit:event=>this.event(state,event),toSnapshot:()=>({name:'Protected stateful migration',data:{events:state.events},description:'Fenced source, retained backup, verified replacement and explicit cutover.'})};
  let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,failed=false,captureFailed=false;
  try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.enableNarrative();executor.attachCombinedRecorder(control);executor.attachCombinedRecorder(progress);for(const recorder of this.options.recorders??[])executor.attachCombinedRecorder(recorder);await executor.run();}
  catch{failed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
  const snapshot=executor?.getSnapshot();if(!snapshot?.runId){state.status='incomplete';delete state.pendingAction;state.error='Native migration recording could not be started';await this.persist(state);return readMigrationState(state);}
  captureFailed||=(snapshot.sink?.failed??0)>0;let status:'passed'|'failed'|'incomplete'=failed||captureFailed||config.uncertain?'incomplete':config.blocked?'failed':'passed';const controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const entry=control.asLookup()(commit.runtimeStageId);if(entry)controlDeps[commit.runtimeStageId]=entry;}
  try{await store.writeJson(evidencePath,{version:1,kind:'migration-native-evidence',runId:snapshot.runId,definitionDigest:this.definitionDigest,executionId:state.executionId,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor!.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},status,limitations:['Provider internals require their own evidence. No rows, paths or private handles are recorded. A fence protects only cooperating writers. No source, backup or replacement deletion is supported. Cross-run continuation references are not fabricated causal edges.']});}catch{captureFailed=true;status='incomplete';}
  state.recordings.push({runId:snapshot.runId,evidencePath,tracePath,status,kind:segment});
  if(failed||captureFailed){state.status='incomplete';delete state.pendingAction;state.error='Migration capture or persistence is incomplete. Inspect actual provider state before further actions.';}
  await this.persist(state);return readMigrationState(state);
 }
 private event(state:MigrationState,event:EmitEvent){if(event.name!==MIGRATION_EVENT)return;const item=event.payload as {executionId:string;stepId:string;phase:MigrationState['events'][number]['phase'];status:MigrationState['events'][number]['status']};if(item.executionId!==state.executionId)return;state.events.push({sequence:state.events.length+1,...item,timestamp:event.timestamp,runtimeStageId:event.runtimeStageId});}
}
