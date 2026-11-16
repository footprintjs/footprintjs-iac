import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { verifyEvidenceTrace, type EvidenceTraceInput } from '../evidence-trace.ts';
import type { Plan } from '../types.ts';
import { canonical, fingerprint, operationId } from '../util.ts';
import { jsonCopy } from '../graph/data.ts';
import { ADAPTER_FLOW_EVENT, type AdapterFlowEvent, type AdapterFlowPhase, type AdapterFlowStatus } from './types.ts';
import { readAdapterFlowEvent } from './recorder.ts';
import type { RecordEntry } from 'foottrace/write';

export interface AdmittedAdapterComponent {
  componentId:string; resourceId:string; adapterId:string; operationId:string; phase:AdapterFlowPhase; status:AdapterFlowStatus;
  installed?:boolean;running?:boolean;
  evidence:{kind:'adapter';runId:string;runtimeStageId:string;complete:true};
}
/** Reopen proof is read-only: retained observer events alone cannot establish a component observation. */
export async function admitAdapterFlowEvents(input:{evidence:EvidenceTraceInput&{runId:string};plan:Plan;events:readonly AdapterFlowEvent[];
  components:readonly {componentId:string;resourceId:string}[]}):Promise<readonly AdmittedAdapterComponent[]> {
  const verified=await verifyEvidenceTrace(input.evidence);
  if(!Array.isArray(input.events)||input.events.length>100_000||!Array.isArray(input.components)||input.components.length>10_000)throw Error('adapter-evidence-bounds');
  const file=readRecordFile(input.evidence.tracePath!),record=readStoredRecord(file.entries),latest=new Map<string,AdmittedAdapterComponent>();
  const events=jsonCopy(input.events) as unknown as AdapterFlowEvent[],plan=jsonCopy(input.plan) as unknown as Plan;
  // A complete root does not make an interrupted child complete.
  if([...record.logs.values()].some(log=>!log.complete||log.gaps.length))throw Error('adapter-child-capture-incomplete');
  const admit=(event:AdapterFlowEvent,authoritative:boolean)=>{
    if(event.runId!==verified.runId||event.deploymentRunId!==input.evidence.runId)throw Error('adapter-event-run-differs');
    if(!event.componentId)return;
    const operation=plan.operations.find(operation=>operation.resource.id===event.resourceId&&operation.operationId===event.operationId&&operation.resource.provider===event.adapterId);
    if(!operation||!input.components.some(component=>component.componentId===event.componentId&&component.resourceId===event.resourceId))throw Error('adapter-event-binding-differs');
    if(operation.desiredFingerprint!==fingerprint(operation.resource.spec)||operation.operationId!==operationId(plan.stack,operation.resource,'apply'))throw Error('adapter-plan-identity-differs');
    const mount=event.drillPath[0],root=record.root(verified.runId);
    if(!mount||!root?.commitLog.some(commit=>commit.stageId===`execute-${event.resourceId}`&&commit.runtimeStageId===mount))throw Error('adapter-parent-mount-differs');
    const lifecycle=record.log({logRunId:event.logRunId,drillPath:[mount]});
    if(!lifecycle?.commitLog.length||canonical(stateAt(lifecycle,0).state.desiredSpec)!==canonical(operation.resource.spec)
      ||stateAt(lifecycle,0).state.planAction!==operation.action)throw Error('adapter-operation-input-differs');
    const intentStage=`execute-${event.resourceId}/native-intent`;
    if(!lifecycle?.complete||!lifecycle.commitLog.some((commit,index)=>commit.stageId===intentStage
      &&canonical(stateAt(lifecycle,index).state.nativeIntent)===canonical({operationId:event.operationId,desiredFingerprint:operation.desiredFingerprint}))) {
      // A no-op verification has an explicit null intent and a reviewed resource observation.
      if(!lifecycle?.commitLog.some((commit,index)=>commit.stageId===intentStage&&stateAt(lifecycle,index).state.nativeIntent===null
        &&stateAt(lifecycle,index).state.planAction===operation.action))throw Error('adapter-operation-intent-differs');
    }
    const log=record.log({logRunId:event.logRunId,drillPath:event.drillPath});
    if(!log||!log.complete||!event.drillPath.length)throw Error('adapter-component-log-missing');
    const key=`adapterComponent:${event.componentId}`;
    const {runId,logRunId,runtimeStageId,subflowPath,drillPath,stageName,timestamp,sequence,committedThroughIdx,...payload}=event;
    const commit=log.commitLog.find((commit,index)=>{
      if(index<=committedThroughIdx||commit.runtimeStageId!==runtimeStageId||!commit.trace.some(row=>row.path===key&&row.verb==='set'))return false;
      const retained=stateAt(log,index).state[key];
      // A live start event and its measured completion share one native commit.
      // Only that provisional event may match the same component/phase identity;
      // authoritative facts below always come from the exact committed payload.
      if(!authoritative&&payload.status==='running'&&retained&&typeof retained==='object'&&!Array.isArray(retained)){
        const value=retained as Record<string,unknown>;
        return ['version','deploymentRunId','adapterId','resourceId','operationId','componentId','phase'].every(field=>value[field]===(payload as unknown as Record<string,unknown>)[field]);
      }
      return canonical(retained)===canonical(payload);
    });
    if(!commit)throw Error('adapter-component-write-missing');
    if(authoritative)latest.set(`${event.resourceId}\0${event.componentId}`,Object.freeze({componentId:event.componentId,resourceId:event.resourceId,adapterId:event.adapterId,operationId:event.operationId,
      phase:event.phase,status:event.status,...(event.installed===undefined?{}:{installed:event.installed}),...(event.running===undefined?{}:{running:event.running}),
      evidence:{kind:'adapter' as const,runId:verified.runId,runtimeStageId:event.runtimeStageId,complete:true as const}}));
  };
  let previous=0;
  for(const event of events){
    if(!Number.isSafeInteger(event.sequence)||event.sequence<=previous)throw Error('adapter-event-sequence-differs');
    previous=event.sequence;admit(event,false);
  }
  // The observer snapshot is advisory. Only native commit delivery order selects
  // the terminal fact; omitted/reordered historical events cannot restore green.
  let sequence=0;
  for(const value of file.entries){
    const entry=value as RecordEntry;
    if(entry.kind!=='commit')continue;
    const log=record.log(entry.address),index=entry.bundle.idx;
    if(!log||!Number.isSafeInteger(index))throw Error('adapter-component-commit-invalid');
    for(const row of entry.bundle.trace){
      if(row.verb!=='set'||!row.path.startsWith('adapterComponent:'))continue;
      const componentId=row.path.slice('adapterComponent:'.length);
      if(!input.components.some(component=>component.componentId===componentId))continue;
      const payload=stateAt(log,index!).state[row.path];
      const event=readAdapterFlowEvent({name:ADAPTER_FLOW_EVENT,payload,stageName:entry.bundle.stage,runtimeStageId:entry.bundle.runtimeStageId,
        pipelineId:'',subflowPath:[],timestamp:entry.at,sourcePosition:{runId:verified.runId,logRunId:entry.address.logRunId,drillPath:entry.address.drillPath,committedThroughIdx:index!-1}},++sequence);
      if(!event)throw Error('adapter-component-write-invalid');
      admit(event,true);
    }
  }
  return Object.freeze([...latest.values()]);
}
