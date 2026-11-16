import { ADAPTER_FLOW_EVENT, type AdapterFlowEvent } from '../adapter-flow/types.ts';
import { readAdapterFlowEvent } from '../adapter-flow/recorder.ts';
import { freeze, jsonCopy } from '../graph/data.ts';
import type { TopologyActionObservation, TopologyNode, TopologyNodeAction } from './types.ts';

export interface TopologyActionBinding { adapterId:string; resourceId:string; operationId:string }
export interface TopologyActionCapture { version:1; events:readonly AdapterFlowEvent[]; ignoredEvents:number; subscriberFailures:number }
export interface LiveTopologyActionInput { deploymentRunId:string; nativeRunId:string; bindings:readonly TopologyActionBinding[]; capture:TopologyActionCapture }

/** Detach and bound recorder data before it becomes provisional display evidence. */
export function readActionCapture(input:TopologyActionCapture):TopologyActionCapture {
 const data=jsonCopy(input) as unknown as TopologyActionCapture;
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['version','events','ignoredEvents','subscriberFailures'].includes(key))
   ||data.version!==1||!Array.isArray(data.events)||data.events.length>10_000||data.ignoredEvents!==0||data.subscriberFailures!==0)throw Error('topology-action-capture-incomplete');
 let sequence=0;
 for(const event of data.events){
  const {runId,logRunId,runtimeStageId,subflowPath,drillPath,stageName,timestamp,sequence:current,committedThroughIdx,...payload}=event;
  const read=readAdapterFlowEvent({name:ADAPTER_FLOW_EVENT,payload,stageName,runtimeStageId,subflowPath,timestamp,pipelineId:'',sourcePosition:{runId,logRunId,drillPath,committedThroughIdx}},current);
  if(!read||current<=sequence)throw Error('topology-action-event-invalid');sequence=current;
 }
 return freeze(data);
}
const safeText=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
const actionKey=(row:TopologyActionObservation)=>[row.resourceId,row.componentId??'',row.phase,row.evidence.runtimeStageId].join('\0');
export function latestTopologyActions(rows:readonly TopologyActionObservation[]):readonly TopologyActionObservation[]{
 const latest=new Map<string,TopologyActionObservation>();
 for(const row of rows){const key=actionKey(row);latest.delete(key);latest.set(key,row);}
 if(latest.size>2_048)throw Error('topology-action-bounds');
 return freeze([...latest.values()]);
}
export function actionFromEvent(event:AdapterFlowEvent,complete:boolean):TopologyActionObservation {
 return {resourceId:event.resourceId,...event.componentId?{componentId:event.componentId}:{},phase:event.phase,status:event.status,
   evidence:{kind:'adapter',runId:event.runId,runtimeStageId:event.runtimeStageId,complete}};
}
/** Real observed actions; completed observer callbacks never establish component readiness. */
export function liveTopologyActions(input:LiveTopologyActionInput):readonly TopologyActionObservation[]{
 const data=jsonCopy(input) as unknown as LiveTopologyActionInput;
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['deploymentRunId','nativeRunId','bindings','capture'].includes(key))
   ||!safeText(data.deploymentRunId)||!safeText(data.nativeRunId)
   ||!Array.isArray(data.bindings)||data.bindings.length>256)throw Error('topology-action-binding-invalid');
 const bindings=new Set<string>();
 for(const row of data.bindings){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['adapterId','resourceId','operationId'].includes(key))
   ||['adapterId','resourceId','operationId'].some(key=>!safeText(row[key as keyof TopologyActionBinding])))throw Error('topology-action-binding-invalid');
  const key=[row.adapterId,row.resourceId,row.operationId].join('\0');if(bindings.has(key))throw Error('topology-action-binding-invalid');bindings.add(key);}
 const capture=readActionCapture(data.capture);
 return latestTopologyActions(capture.events.map(event=>{
  if(event.deploymentRunId!==data.deploymentRunId||event.runId!==data.nativeRunId||!bindings.has([event.adapterId,event.resourceId,event.operationId].join('\0')))throw Error('topology-action-binding-differs');
  return actionFromEvent(event,false);
 }));
}
const componentLabels={inspect:'Inspecting component',revalidate:'Checking existing component',configure:'Updating component configuration',reload:'Reloading component configuration',start:'Starting component',apply:'Applying component changes',observe:'Checking component'};
const sharedLabels={inspect:'Inspecting shared resource',revalidate:'Checking existing setup',configure:'Updating shared configuration',reload:'Reloading shared configuration',start:'Restarting service group',apply:'Applying shared resource changes',observe:'Checking shared resource'};
/** Binding selects the cards; a neighbouring resource never lends its action to a database. */
export function projectNodeActions(node:TopologyNode,actions:readonly TopologyActionObservation[]):readonly TopologyNodeAction[]{
 return actions.filter(action=>node.bindings.resourceIds.includes(action.resourceId)
   &&(action.componentId?(node.bindings.componentIds??[]).includes(action.componentId):!!node.bindings.componentIds?.length))
 .map(action=>({...action,scope:action.componentId?'component' as const:'shared-resource' as const,label:(action.componentId?componentLabels:sharedLabels)[action.phase]}));
}
