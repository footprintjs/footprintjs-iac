import type { JsonObject } from '../types.ts';

export const DELIVERY_EVENT = 'iac:delivery-progress';
export const DELIVERY_STAGE_IDS = ['resolve', 'fetch', 'build', 'publish', 'plan', 'deploy', 'verify'] as const;
export type DeliveryStageId = typeof DELIVERY_STAGE_IDS[number];
export type DeliveryStageStatus = 'pending' | 'running' | 'passed' | 'failed';
export interface DeliveryTarget { id: string; scope: string }
export interface DeliverySource { repository: string; ref: string }
export interface DeliveryRecipe { id: string; digest: string }
export interface DeliveryDefinition {
  id: string; label: string; target: DeliveryTarget; source: DeliverySource; recipe: DeliveryRecipe;
  /** Binds fixed host settings, adapter versions and acceptance checks to this immutable delivery. */
  configurationDigest: string;
}
export interface SourceRevision { repository: string; ref: string; commit: string; tree: string }
/** Host-controlled local source location. Never accepted from a browser request. Contains no credentials. */
export interface SourceSnapshot { revision: SourceRevision; location: string }
export interface DeliveryArtifact { id: string; digest: string; reference: string }
export interface DeliveryBuild { artifacts: DeliveryArtifact[]; recipeDigest: string; metadata?: JsonObject }
export interface DeliveryPublication { artifacts: DeliveryArtifact[]; metadata?: JsonObject }
/** A verified cross-run receipt link; it never claims an invented causal edge between independent runs. */
export interface WorkflowEvidenceReference {kind:string;digest:string;runId:string}
export interface DeliveryPlan {
  id: string; digest: string; changes: { resourceId: string; action: 'create' | 'update' | 'verify' | 'delete' | 'noop' }[];
  /** Non-secret host receipt, e.g. the existing master workflow review ID. */
  metadata?: JsonObject;
  evidence?:WorkflowEvidenceReference[];
}
export interface DeliveryDeployment { ok: boolean; runId?: string; evidencePath?: string; tracePath?: string; metadata?: JsonObject;evidence?:WorkflowEvidenceReference[] }
export interface DeliveryVerification { ok: boolean; checks: { id: string; passed: boolean }[]; metadata?: JsonObject }
export interface DeliveryContext {
  executionId: string; operationId: string; definitionDigest: string; target: DeliveryTarget;
}
export interface SourceAdapter {
  resolve(source: DeliverySource, context: DeliveryContext): Promise<SourceRevision>;
  fetch(revision: SourceRevision, context: DeliveryContext): Promise<SourceSnapshot>;
}
export interface BuildAdapter { build(source: SourceSnapshot, recipe: DeliveryRecipe, context: DeliveryContext): Promise<DeliveryBuild> }
export interface ArtifactStore { publish(build: DeliveryBuild, context: DeliveryContext): Promise<DeliveryPublication> }
export interface DeploymentAdapter {
  plan(publication: DeliveryPublication, context: DeliveryContext): Promise<DeliveryPlan>;
  deploy(plan: DeliveryPlan, context: DeliveryContext): Promise<DeliveryDeployment>;
  verify(deployment: DeliveryDeployment, context: DeliveryContext): Promise<DeliveryVerification>;
}
export interface DeliveryAdapters { source: SourceAdapter; build: BuildAdapter; artifacts: ArtifactStore; deployment: DeploymentAdapter }
export interface DeliveryStage { id: DeliveryStageId; label: string; status: DeliveryStageStatus }
export interface DeliveryEvent {
  sequence: number; executionId: string; stageId: DeliveryStageId; status: Exclude<DeliveryStageStatus, 'pending'>;
  timestamp: number; runtimeStageId: string;
}
export interface DeliveryResults {
  revision?: SourceRevision; source?: SourceSnapshot; build?: DeliveryBuild; publication?: DeliveryPublication;
  plan?: DeliveryPlan; deployment?: DeliveryDeployment; verification?: DeliveryVerification;
}
export interface DeliveryRecording {
  runId: string; evidencePath: string; tracePath: string; status: 'passed' | 'failed' | 'incomplete';
}
export interface DeliveryState {
  version: 1; kind: 'delivery-state'; definition: DeliveryDefinition; definitionDigest: string;
  executionId: string | null; status: 'idle' | 'running' | 'passed' | 'failed' | 'incomplete';
  stages: DeliveryStage[]; events: DeliveryEvent[]; results: DeliveryResults; recordings: DeliveryRecording[];
  error?: string;
}
