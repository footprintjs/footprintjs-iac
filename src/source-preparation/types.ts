import type {DeliveryAdapters,DeliveryDefinition,DeliveryEvent,DeliveryRecording,DeliveryResults,DeliveryStage,SourceRevision} from '../delivery/types.ts';

export const SOURCE_PREPARATION_STAGE_IDS=['resolve','fetch','build','publish'] as const;
export type SourcePreparationStageId=typeof SOURCE_PREPARATION_STAGE_IDS[number];
export interface SourcePreparationDefinition extends DeliveryDefinition {
 /** Optional immutable version selected by a trusted release catalog before preparation. */
 expectedRevision?:SourceRevision;
}
export type SourcePreparationAdapters=Pick<DeliveryAdapters,'source'|'build'|'artifacts'>;
export type SourcePreparationResults=Pick<DeliveryResults,'revision'|'source'|'build'|'publication'>;
export interface SourcePreparationState {
 version:1;kind:'source-preparation-state';definition:SourcePreparationDefinition;definitionDigest:string;
 executionId:string|null;status:'idle'|'running'|'passed'|'failed'|'incomplete';
 stages:(Omit<DeliveryStage,'id'>&{id:SourcePreparationStageId})[];
 events:(Omit<DeliveryEvent,'stageId'>&{stageId:SourcePreparationStageId})[];
 results:SourcePreparationResults;recordings:DeliveryRecording[];error?:string;
}
