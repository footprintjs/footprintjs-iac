import type { CombinedRecorder } from 'footprintjs';
import type { JsonObject } from '../types.ts';

export const MIGRATION_PHASES=['inspect','quiesce','backup','create','transfer','verify-data','cutover','verify-consumer','retain','resume'] as const;
export type MigrationPhase=typeof MIGRATION_PHASES[number];
export interface MigrationResource {id:string;scope:string}
export interface MigrationSource extends MigrationResource {identity:string}
export interface MigrationDefinition {
  version:1;id:string;label:string;assessmentDigest:string;changeId:string;configurationDigest:string;
  source:MigrationSource;destination:MigrationResource;strategyId:string;adapterId:string;
  parameters?:JsonObject;
}
export interface MigrationStep {id:string;phase:MigrationPhase;operation:string;parameters?:JsonObject}
export interface MigrationPlan {steps:MigrationStep[]}
export interface MigrationStrategy {id:string;label:string;plan(definition:MigrationDefinition):MigrationPlan}
export interface MigrationDataIdentity {id:string;scope:string;identity:string;snapshot:string}
export interface MigrationFence {id:string;owner:string}
export interface MigrationBackup {id:string;digest:string;sourceSnapshot:string}
export interface MigrationVerification {id:string;digest:string;passed:boolean;sourceSnapshot:string;destinationSnapshot:string}
export interface MigrationObservation {
  source:MigrationDataIdentity;destination?:MigrationDataIdentity;backup?:MigrationBackup;
  /** Exact durable write fence held by this execution, or null when writes are enabled. */
  fence:MigrationFence|null;
  active:'source'|'destination'|'unknown';
  writesAfterCutover:'none'|'present'|'unknown';
  sourceRetained:boolean;
  /** Independent adapter assertion about recovering the original consumer/data contract. */
  rollbackCompatible:boolean;
}
export interface MigrationCheckpoint {
  sourceSnapshot?:string;fence?:MigrationFence;backup?:MigrationBackup;
  destination?:MigrationDataIdentity;verification?:MigrationVerification;
  switched?:boolean;consumerVerified?:boolean;retained?:boolean;writesResumed?:boolean;
}
export interface MigrationRequest {
  executionId:string;operationId:string;definitionDigest:string;assessmentDigest:string;migrationId:string;
  step:{id:string;phase:MigrationPhase|'recover-source'|'verify-recovery'|'resume-source'|'revalidate';operation:string};
  source:MigrationSource;destination:MigrationResource;checkpoint:MigrationCheckpoint;
}
export interface MigrationReceipt {
  request:MigrationRequest;status:'succeeded'|'failed'|'unknown';observation:MigrationObservation;
  backup?:MigrationBackup;verification?:MigrationVerification;
  consumer?:{id:string;digest:string;passed:boolean;activeIdentity:string};
  /** Private host handles only. Rows, credentials and paths must never enter native summaries. */
  metadata?:JsonObject;
}
export interface MigrationAdapter {
  id:string;label:string;capabilities:readonly string[];
  admit?(definition:MigrationDefinition,plan:MigrationPlan):void;
  observe(request:MigrationRequest):Promise<MigrationObservation>;
  execute(step:MigrationStep|{id:string;phase:'recover-source'|'verify-recovery'|'resume-source';operation:string},request:MigrationRequest):Promise<MigrationReceipt>;
}
export interface MigrationRegistry {strategies:readonly MigrationStrategy[];adapters:readonly MigrationAdapter[]}
export type MigrationStatus='idle'|'running'|'waiting'|'passed'|'recovered'|'failed'|'incomplete';
export interface MigrationOperation {id:string;phase:MigrationRequest['step']['phase'];operation:string;status:'intent'|'succeeded'|'failed'|'unknown';request:MigrationRequest;receipt?:MigrationReceipt;observation?:MigrationObservation}
export interface MigrationRecording {runId:string;evidencePath:string;tracePath:string;kind:'prepare'|'cutover'|'recovery';status:'passed'|'failed'|'incomplete'}
export interface MigrationActionRequest {executionId:string;token:string;checkpointDigest:string}
export interface MigrationPendingAction extends MigrationActionRequest {kind:'cutover'|'recover'|'inspect'}
export interface MigrationEvent {sequence:number;executionId:string;stepId:string;phase:MigrationRequest['step']['phase'];status:'running'|'passed'|'failed'|'incomplete';timestamp:number;runtimeStageId:string}
export interface MigrationState {
  version:1;kind:'stateful-migration';definition:MigrationDefinition;definitionDigest:string;
  executionId:string|null;status:MigrationStatus;checkpoint:MigrationCheckpoint;operations:MigrationOperation[];
  recordings:MigrationRecording[];events:MigrationEvent[];pendingAction?:MigrationPendingAction;error?:string;
}
export interface MigrationWorkflowPort {
  snapshot():Promise<MigrationState>;start():Promise<MigrationState>;
  cutover(request:MigrationActionRequest):Promise<MigrationState>;
  recover(request:MigrationActionRequest):Promise<MigrationState>;
  subscribe(listener:(state:MigrationState)=>void):()=>void;
}
export interface MigrationRecorderOptions {recorders?:readonly CombinedRecorder[]}
