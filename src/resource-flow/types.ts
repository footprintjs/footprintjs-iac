/** Public JSON contracts. They contain references and measured outcomes, never credentials. */
export type ResourceFlowStageId = 'acquire' | 'details' | 'connect' | 'verify';
export type ResourceFlowStageStatus = 'pending' | 'running' | 'waiting' | 'passed' | 'failed';
export interface ResourceFlowTarget { id: string; scope: string }
export interface ResourceFlowDefinition { id: string; resourceId: string; label: string; mode: 'create' | 'existing'; target: ResourceFlowTarget; configurationDigest: string }
export interface ConnectionProfileChoice { id: string; label: string }
export interface FlowReceipt { id: string; runId?: string; evidencePath?: string }
export interface ResourceHandle { id: string; kind: string; physicalId: string; scope: string; receipt?: FlowReceipt }
export interface ConnectionDetails {
  profileId: string; resourceId: string; endpoint: string; protocol: string;
  credentialRef?: string; trustRef?: string;
}
export interface VerificationResult { ok: boolean; checks: { id: string; passed: boolean }[]; receipts?: FlowReceipt[] }
export interface ResourceFlowContext { executionId: string; operationId: string; definitionDigest: string; profileId?: string }
export interface ResourceFlowAdapters {
  create?(context: ResourceFlowContext): Promise<ResourceHandle>;
  /** Read-only identity lookup. Also revalidates a created handle before connection and after a pause. */
  find(context: ResourceFlowContext): Promise<ResourceHandle>;
  resolveDetails(resource: ResourceHandle, profileId: string | undefined, context: ResourceFlowContext): Promise<ConnectionDetails | undefined>;
  validate(resource: ResourceHandle, details: ConnectionDetails | undefined, context: ResourceFlowContext): Promise<void>;
  connect(resource: ResourceHandle, details: ConnectionDetails, context: ResourceFlowContext): Promise<FlowReceipt>;
  verify(resource: ResourceHandle, details: ConnectionDetails, connection: FlowReceipt, context: ResourceFlowContext): Promise<VerificationResult>;
}
export interface ResourceFlowStage { id: ResourceFlowStageId; label: string; status: ResourceFlowStageStatus }
export interface ResourceFlowEvent {
  sequence: number; executionId: string; stageId: ResourceFlowStageId; status: ResourceFlowStageStatus;
  timestamp: number; runtimeStageId: string;
}
export interface ResourceFlowSegment {
  runId: string; evidencePath: string; tracePath: string; status: 'paused' | 'passed' | 'failed' | 'incomplete';
  resumedFromRunId?: string;
}
export interface ResourceFlowFailure { stageId: ResourceFlowStageId; code: string; receipt?: FlowReceipt }
export interface ResourceFlowState {
  version: 1; kind: 'resource-flow-state'; definitionDigest: string;
  id: string; resourceId: string; label: string; mode: 'create' | 'existing'; target: ResourceFlowTarget; configurationDigest: string;
  executionId: string | null; status: 'idle' | 'running' | 'paused' | 'passed' | 'failed' | 'incomplete';
  stages: ResourceFlowStage[]; events: ResourceFlowEvent[]; segments: ResourceFlowSegment[];
  /** Immutable connection profile selected before acquisition. Contains no credential values. */
  selectedProfileId?: string;
  resource?: ResourceHandle; details?: ConnectionDetails; connection?: FlowReceipt; verification?: VerificationResult;
  pause?: { token: string; prompt: string; profiles: ConnectionProfileChoice[] };
  error?: string; failure?: ResourceFlowFailure;
}
export interface ResourceFlowResumeInput { pauseToken: string; profileId: string }
export interface ResourceFlowStartInput { profileId: string }
export const RESOURCE_FLOW_EVENT = 'iac.resource-flow.progress';
