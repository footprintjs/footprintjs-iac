import type {EmitEvent} from 'footprintjs';
import {DELIVERY_EVENT,type DeliveryEvent,type DeliveryStage} from '../delivery/types.ts';

export const PREPARATION_STAGE_IDS=['resolve','fetch','build','publish'] as const;
export const PREPARATION_STAGE_LABELS=['Choose exact version','Get code','Build package','Store package'] as const;
/** Keep actual native event identities; no timer or observer fabricates progress. */
export function recordPreparationProgress(state:{executionId:string|null;events:DeliveryEvent[];stages:DeliveryStage[]},event:EmitEvent):void{
 if(event.name!==DELIVERY_EVENT)return;const value=event.payload as Partial<DeliveryEvent>|undefined;
 if(!value||value.executionId!==state.executionId||!PREPARATION_STAGE_IDS.includes(value.stageId as typeof PREPARATION_STAGE_IDS[number])
  ||!['running','passed','failed'].includes(value.status??'')||!Number.isFinite(event.timestamp))return;
 const item:DeliveryEvent={sequence:state.events.length+1,executionId:state.executionId!,stageId:value.stageId!,status:value.status!,timestamp:event.timestamp,runtimeStageId:event.runtimeStageId};
 state.events.push(item);state.stages=state.stages.map(stage=>stage.id===item.stageId?{...stage,status:item.status}:stage);
}
