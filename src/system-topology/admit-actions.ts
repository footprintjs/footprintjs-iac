import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import type { RecordEntry } from 'foottrace/write';
import { verifyEvidenceTrace, type EvidenceTraceInput } from '../evidence-trace.ts';
import { ADAPTER_FLOW_EVENT } from '../adapter-flow/types.ts';
import { readAdapterFlowEvent } from '../adapter-flow/recorder.ts';
import { jsonCopy } from '../graph/data.ts';
import { canonical, fingerprint, operationId } from '../util.ts';
import type { Plan } from '../types.ts';
import { actionFromEvent, latestTopologyActions, liveTopologyActions, readActionCapture, type TopologyActionCapture } from './actions.ts';
import type { TopologyActionObservation } from './types.ts';

/** Reopens only retained native data. Observer history cannot select the final action. */
export async function admitTopologyActions(input:{evidence:EvidenceTraceInput&{runId:string};plan:Plan;capture:TopologyActionCapture}):Promise<readonly TopologyActionObservation[]>{
 const verified=await verifyEvidenceTrace(input.evidence),plan=jsonCopy(input.plan) as unknown as Plan,capture=readActionCapture(input.capture);
 liveTopologyActions({deploymentRunId:input.evidence.runId,nativeRunId:verified.runId,bindings:plan.operations.map(operation=>({adapterId:operation.resource.provider,resourceId:operation.resource.id,operationId:operation.operationId})),capture});
 const file=readRecordFile(input.evidence.tracePath!),record=readStoredRecord(file.entries),root=record.root(verified.runId);
 if([...record.logs.values()].some(log=>!log.complete||log.gaps.length))throw Error('topology-action-child-capture-incomplete');
 const rows:TopologyActionObservation[]=[];let sequence=0;
 for(const value of file.entries){
  const entry=value as RecordEntry;if(entry.kind!=='commit')continue;
  const log=record.log(entry.address),index=entry.bundle.idx;
  if(!log||!Number.isSafeInteger(index))throw Error('topology-action-commit-invalid');
  const paths=new Set(entry.bundle.trace.filter(row=>row.verb==='set'&&(row.path==='adapterFlowProgress'||row.path.startsWith('adapterComponent:'))).map(row=>row.path));
  for(const path of paths){
   const payload=stateAt(log,index!).state[path];
   const event=readAdapterFlowEvent({name:ADAPTER_FLOW_EVENT,payload,stageName:entry.bundle.stage,runtimeStageId:entry.bundle.runtimeStageId,pipelineId:'',subflowPath:[],timestamp:entry.at,
    sourcePosition:{runId:verified.runId,logRunId:entry.address.logRunId,drillPath:entry.address.drillPath,committedThroughIdx:index!-1}},++sequence);
   if(!event||event.deploymentRunId!==input.evidence.runId)throw Error('topology-action-native-write-invalid');
   const operation=plan.operations.find(operation=>operation.resource.id===event.resourceId&&operation.operationId===event.operationId&&operation.resource.provider===event.adapterId);
   if(!operation||operation.desiredFingerprint!==fingerprint(operation.resource.spec)||operation.operationId!==operationId(plan.stack,operation.resource,'apply'))throw Error('topology-action-operation-differs');
   const mount=event.drillPath[0];
   if(!mount||!root?.commitLog.some(commit=>commit.stageId===`execute-${event.resourceId}`&&commit.runtimeStageId===mount))throw Error('topology-action-parent-mount-differs');
   const lifecycle=record.log({logRunId:event.logRunId,drillPath:[mount]});
   if(!lifecycle?.commitLog.length||canonical(stateAt(lifecycle,0).state.desiredSpec)!==canonical(operation.resource.spec)||stateAt(lifecycle,0).state.planAction!==operation.action)throw Error('topology-action-operation-input-differs');
   if(!lifecycle.commitLog.some((commit,index)=>commit.stageId===`execute-${event.resourceId}/native-intent`&&(
    canonical(stateAt(lifecycle,index).state.nativeIntent)===canonical({operationId:event.operationId,desiredFingerprint:operation.desiredFingerprint})
    ||stateAt(lifecycle,index).state.nativeIntent===null&&stateAt(lifecycle,index).state.planAction===operation.action)))throw Error('topology-action-operation-intent-differs');
   rows.push(actionFromEvent(event,true));
  }
 }
 return latestTopologyActions(rows);
}
