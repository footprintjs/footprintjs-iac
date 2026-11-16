import {randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {canonical,fingerprint} from '../util.ts';
import {identifier} from '../graph/data.ts';
import {ONBOARDING_STAGE_IDS,type OnboardingAction,type OnboardingSnapshot,type OnboardingWorkflowOptions} from './types.ts';
import {ONBOARDING_STAGE_LABELS,onboardingObject,readOnboardingAction,readOnboardingSnapshot} from './data.ts';
import {createOnboardingPreset} from './preset.ts';
import {onboardingBindingDigest} from './binding.ts';
import {onboardingPermissions} from './permissions.ts';
import {createOnboardingChart} from './create-onboarding-chart.ts';
import {onboardingStageId} from './stages.ts';
import {OnboardingStore} from './store.ts';
import {admitOnboardingRecording} from './recording.ts';
import type {OnboardingState,OnboardingEntry} from './state.ts';
/** Durable guided composition over an existing deployment adapter. The adapter retains all mutation/reconciliation authority. */
export class OnboardingWorkflow {
 private readonly preset;private readonly store:OnboardingStore;private readonly bindingDigest:string;private readonly recorders:readonly CombinedRecorder[];private live=false;private capturePending=false;
 private readonly listeners=new Set<(snapshot:OnboardingSnapshot)=>void>();
 constructor(options:OnboardingWorkflowOptions){
  if(!isAbsolute(options.directory))throw Error('Register an absolute private onboarding directory');this.preset=createOnboardingPreset(options.preset);this.store=new OnboardingStore(resolve(options.directory));this.recorders=[...options.recorders??[]];
  this.bindingDigest=onboardingBindingDigest(this.preset);
 }
 subscribe(listener:(snapshot:OnboardingSnapshot)=>void){if(typeof listener!=='function')throw Error('Register onboarding listener');this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 async snapshot():Promise<OnboardingSnapshot>{return this.project(await this.load());}
 /** Read-only admitted native evidence; this method never invokes a provider or attempts recovery. */
 async recording(){const state=await this.load(),entry=state.entries.at(-1);return entry?.proof?admitOnboardingRecording(entry,this.store.directory,this.bindingDigest):undefined;}
 dispatch(input:OnboardingAction):Promise<OnboardingSnapshot>{const action=readOnboardingAction(input);if(action.action==='refresh')return this.snapshot();return this.store.withLock(async()=>{
  const state=await this.load(),before=this.project(state);this.admitAction(before,action);if(state.entries.length>=256)throw Error('Onboarding history limit reached; retain it and register a new onboarding session');
  const view=structuredClone(before);delete view.recording;delete view.error;
  if(action.action!=='reconcile'){
   const index=ONBOARDING_STAGE_IDS.indexOf(onboardingStageId(action.action));view.stages=view.stages.map((row,i)=>i>=index?{...row,status:i===index?'running':'pending'}:row);delete view.deployment;if(action.action!=='deploy')delete view.review;
  }else view.stages=view.stages.map(row=>row.id==='deploy'?{...row,status:'running'}:row);
  view.status=action.action==='reconcile'?'incomplete':action.action==='discover'?'idle':action.action==='configure'?'discovered':action.action==='verify'?'configured':action.action==='review'?'verified':'reviewed';view.busy=true;state.view=onboardingPermissions(view,!!this.preset.deployment.reconcile);const entry:OnboardingEntry={id:randomUUID(),action,before};state.entries.push(entry);await this.store.save(state);this.live=true;this.capturePending=true;this.publish(this.project(state));
  try{return await this.execute(state,entry);}finally{this.live=false;this.capturePending=false;}
 });}
 private initial():OnboardingState {const {version,...definition}=this.preset.definition;return{version:1,kind:'onboarding-state',bindingDigest:this.bindingDigest,entries:[],view:onboardingPermissions({...definition,status:'idle',busy:false,stages:ONBOARDING_STAGE_IDS.map(id=>({id,label:ONBOARDING_STAGE_LABELS[id],status:'pending'})),checks:[],canDiscover:true,canConfigure:false,canVerify:false,canReview:false,canDeploy:false,canReconcile:false},!!this.preset.deployment.reconcile)};}
 private async load():Promise<OnboardingState>{
  const raw=await this.store.load();if(raw===undefined)return this.initial();const data=onboardingObject(raw,['version','kind','bindingDigest','view','entries']);
  if(data.version!==1||data.kind!=='onboarding-state'||data.bindingDigest!==this.bindingDigest||!Array.isArray(data.entries)||data.entries.length>256)throw Error('Onboarding preset differs from its retained session');
  const state:OnboardingState={version:1,kind:'onboarding-state',bindingDigest:this.bindingDigest,view:readOnboardingSnapshot(data.view),entries:[]};
  for(const [index,input]of data.entries.entries()){
   const item=onboardingObject(input,['id','action','before','after','proof']),entry:OnboardingEntry={id:identifier(item.id,'onboarding operation'),action:readOnboardingAction(item.action),before:readOnboardingSnapshot(item.before)};
   if(item.after!==undefined)entry.after=readOnboardingSnapshot(item.after);
   if(item.proof!==undefined){const p=onboardingObject(item.proof,['runId','evidencePath','tracePath','digest']);entry.proof={runId:identifier(p.runId,'onboarding run'),evidencePath:String(p.evidencePath),tracePath:String(p.tracePath),digest:String(p.digest)};await admitOnboardingRecording(entry,this.store.directory,this.bindingDigest);}
   else if(index<data.entries.length-1)throw Error('Onboarding history contains an unfinished earlier transition');
   state.entries.push(entry);
  }
  const last=state.entries.at(-1);if(last?.proof&&canonical(last.after)!==canonical(state.view))throw Error('Onboarding ledger differs from recorded outcome');
  if(state.view.id!==this.preset.definition.id||state.view.strategyId!==this.preset.definition.strategyId||state.view.targetId!==this.preset.definition.targetId||state.view.configurationDigest!==this.preset.definition.configurationDigest||state.view.profileId!==this.preset.definition.profileId)throw Error('Onboarding target identity differs');
  if(last&&!last.proof&&!this.live){state.view={...state.view,...state.view.deployment?{deployment:{ok:false,promoted:false,status:'incomplete' as const}}:{},busy:false,status:'incomplete',error:'A retained onboarding transition has no complete native outcome. Inspect its deployment evidence before continuing.',canDiscover:false,canConfigure:false,canVerify:false,canReview:false,canDeploy:false,canReconcile:!!this.preset.deployment.reconcile&&!!state.view.review?.reviewId};}
  return state;
 }
 private project(state:OnboardingState):OnboardingSnapshot {const last=state.entries.at(-1);let value=state.view;if(this.live&&this.capturePending&&last?.after&&!last.proof){const stageId=onboardingStageId(last.action.action);value={...last.before,busy:true,stages:last.before.stages.map(row=>row.id===stageId?{...row,status:'running'}:row)};delete value.recording;}const view=onboardingPermissions(value,!!this.preset.deployment.reconcile);return readOnboardingSnapshot({...view,...last?.proof?{recording:{runId:last.proof.runId}}:{}});}
 private publish(view:OnboardingSnapshot){for(const listener of this.listeners)try{listener(readOnboardingSnapshot(view));}catch{/* Observers cannot control deployment. */}}
 private admitAction(view:OnboardingSnapshot,action:OnboardingAction){const allowed:Record<string,boolean>={discover:view.canDiscover,configure:view.canConfigure,verify:view.canVerify,review:view.canReview,deploy:view.canDeploy,reconcile:view.canReconcile};if(!allowed[action.action])throw Error('Onboarding action is not admitted by the current measured stage');if((action.action==='deploy'||action.action==='reconcile')&&action.reviewId!==view.review?.reviewId)throw Error('Onboarding review differs from current native review');}
 private async execute(state:OnboardingState,entry:OnboardingEntry):Promise<OnboardingSnapshot>{
  const name=randomUUID(),evidencePath=join(this.store.directory,name+'.json'),tracePath=join(this.store.directory,name+'.jsonl');
  const chart=createOnboardingChart({preset:this.preset,bindingDigest:this.bindingDigest,state,entry,persist:async()=>{await this.store.save(state);this.publish(this.project(state));}}),control=controlDepRecorder({id:'iac-onboarding-control'});
  let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,captureFailed=false;
  try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.enableNarrative();executor.attachCombinedRecorder(control);for(const recorder of this.recorders)executor.attachCombinedRecorder(recorder);await executor.run();}catch{captureFailed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
  if(executor&&entry.after){
   const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const value=control.asLookup()(commit.runtimeStageId);if(value)controlDeps[commit.runtimeStageId]=value;}
   captureFailed||=(snapshot.sink?.failed??0)>0;
   const evidence={version:1,kind:'onboarding-native-evidence',runId:snapshot.runId,stack:this.preset.definition.id,bindingDigest:this.bindingDigest,operationId:entry.id,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},limitations:['Registered adapters measure target checks. Deployment mutation, drift checks and uncertain outcomes remain owned by the deployment strategy. Static stage labels do not prove external tool internals.']};
   if(!captureFailed)try{const retained=JSON.parse(JSON.stringify(evidence));await this.store.write(evidencePath,retained);entry.proof={runId:snapshot.runId!,evidencePath,tracePath,digest:fingerprint(retained)};await admitOnboardingRecording(entry,this.store.directory,this.bindingDigest);}catch{captureFailed=true;delete entry.proof;}
  }else captureFailed=true;
  if(captureFailed){state.view=onboardingPermissions({...state.view,...state.view.deployment?{deployment:{ok:false,promoted:false,status:'incomplete' as const}}:{},busy:false,status:'incomplete',error:'Native capture is incomplete. Inspect the original deployment before another attempt.'},!!this.preset.deployment.reconcile);delete entry.proof;}
  this.capturePending=false;await this.store.save(state);const view=this.project(state);this.publish(view);return view;
 }
}
