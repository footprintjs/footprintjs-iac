import type { CombinedRecorder } from 'footprintjs';
import type { JsonObject } from '../types.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import type { CheckRunner, CheckResult } from '../checks/types.ts';
import type {WorkflowEvidenceReference} from '../delivery/types.ts';

export const PIPELINE_EVENT = 'iac:pipeline-progress';
export interface PipelineTarget { id: string; scope: string }
export interface PipelineCheck { runnerId: string; suiteId: string; suiteDigest: string }
export interface PipelineStageDefinition {
  id: string; label: string; target: PipelineTarget;
  strategyId: string; adapterId: string;
  /** Host-approved, non-secret strategy input. Credentials belong in adapter closures. */
  parameters?: JsonObject;
  checks: PipelineCheck[];
  rollback: 'disabled' | 'manual' | 'automatic';
  /** Manual is an explicit durable gate before this stage starts. */
  promotion: 'automatic' | 'manual';
}
export interface PipelineDefinition {
  version: 1; id: string; label: string; configurationDigest: string;
  stages: PipelineStageDefinition[];
}
export interface RolloutAction { kind: 'action'; id: string; operation: string; parameters?: JsonObject }
export interface RolloutAnalysis { kind: 'check'; id: string }
export interface RolloutPlan { steps: (RolloutAction | RolloutAnalysis)[] }
export interface RolloutStrategy {
  id: string; label: string;
  /** Pure, synchronous planning. No provider reads or writes. */
  plan(input: { stage: PipelineStageDefinition; release: ReleaseManifest }): RolloutPlan;
}
export interface RolloutContext {
  executionId: string; operationId: string; definitionDigest: string;
  stageId: string; target: PipelineTarget;
}
export interface RolloutReceipt {
  status: 'succeeded' | 'failed' | 'unknown';
  reference?: string;
  /** Private ledger only; never copied into native trace summaries. */
  metadata?: JsonObject;
  /** Actual provider review; replacement requires explicit adapter support and review. */
  changes?: { resourceId: string; action: 'create' | 'update' | 'verify' | 'delete' | 'noop' | 'replace' }[];
  evidence?:WorkflowEvidenceReference[];
}
export interface ReleaseObservation { known: boolean; releaseDigest: string | null }
export interface RolloutAdapter {
  id: string; label: string;
  /** Supported operation IDs; 'restore' is required when rollback is enabled. */
  capabilities: readonly string[];
  /** Optional pure host admission; throw to reject before any execution effects. */
  admit?(input: { stage: PipelineStageDefinition; release: ReleaseManifest; plan: RolloutPlan }): void;
  execute(action: RolloutAction, release: ReleaseManifest, context: RolloutContext): Promise<RolloutReceipt>;
  /** Read actual deployed release identity; do not infer it from a request's desired value. */
  observe(context: RolloutContext): Promise<ReleaseObservation>;
}
export interface PipelineRegistry {
  strategies: readonly RolloutStrategy[];
  adapters: readonly RolloutAdapter[];
  checks: readonly CheckRunner[];
}
export type PipelineStatus = 'idle' | 'running' | 'waiting' | 'passed' | 'failed' | 'incomplete';
export type PipelineStageStatus = 'pending' | 'waiting' | 'running' | 'passed' | 'failed' | 'rolled-back' | 'incomplete';
export interface PipelineRecording { runId: string; evidencePath: string; tracePath: string; status: 'passed' | 'failed' | 'incomplete'; stageId: string; kind: 'rollout' | 'recovery' }
export interface PipelineOperation {
  id: string; kind: 'action' | 'check' | 'observe'; status: 'intent' | 'succeeded' | 'failed' | 'unknown';
  operation?: string; releaseDigest: string; receipt?: RolloutReceipt; check?: CheckResult; observation?: ReleaseObservation;
}
export interface VerifiedRelease { release: ReleaseManifest; verifiedAt: number; recording: PipelineRecording }
export interface PipelineStageState {
  id: string; label: string; status: PipelineStageStatus; phase: string;
  operations: PipelineOperation[]; baseline?: VerifiedRelease;
  lastApplied?: string; lastVerified?: string;
}
export interface PipelineActionRequest { stageId: string; token: string; releaseDigest: string }
export interface PipelinePendingAction extends PipelineActionRequest { kind: 'promote' | 'recover' }
export interface PipelineEvent {
  sequence: number; executionId: string; stageId: string; phase: string;
  status: 'running' | 'passed' | 'failed' | 'incomplete' | 'rolled-back';
  timestamp: number; runtimeStageId: string;
}
export interface PipelineState {
  version: 1; kind: 'release-pipeline'; definition: PipelineDefinition; definitionDigest: string;
  release: ReleaseManifest; executionId: string | null; status: PipelineStatus;
  stages: PipelineStageState[]; events: PipelineEvent[]; recordings: PipelineRecording[];
  pendingAction?: PipelinePendingAction; error?: string;
}
export interface PipelineWorkflowPort {
  snapshot(): Promise<PipelineState>;
  start(): Promise<PipelineState>;
  promote(request: PipelineActionRequest): Promise<PipelineState>;
  recover(request: PipelineActionRequest): Promise<PipelineState>;
  subscribe(listener: (state: PipelineState) => void): () => void;
}
export interface PipelineRecorders { recorders?: readonly CombinedRecorder[] }
