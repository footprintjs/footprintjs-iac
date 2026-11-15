import type { ResourceFlowContext, ResourceFlowState, ResourceHandle, ConnectionDetails, FlowReceipt, VerificationResult } from '../resource-flow/types.ts';

export const AGENT_CAPABILITIES = ['conversationIsolation', 'revisionRouting', 'durableDataRestore', 'processMemoryRestore'] as const;
export type AgentCapabilityId = string;
export interface AgentArtifactReference { id: string; digest: string; reference?: string }
export interface AgentRevisionInput { agentId: string; behavior: AgentArtifactReference; runtime: AgentArtifactReference }
export interface AgentRevision extends AgentRevisionInput { version: 1; digest: string }
export interface AgentDeploymentInput {
 id: string; label: string; revision: AgentRevision; target: { id: string; scope: string };
 resourceIds: readonly string[]; environmentResourceId: string; mode: 'create' | 'existing';
 requiredCheckIds: readonly string[]; capabilityIds?: readonly AgentCapabilityId[]; requiredCapabilities?: readonly AgentCapabilityId[];
}
export interface AgentDeployment extends Omit<AgentDeploymentInput, 'requiredCapabilities' | 'capabilityIds'> {
 version: 1; kind: 'agent-deployment'; stack: string; graphDigest: string; capabilityIds: readonly AgentCapabilityId[]; requiredCapabilities: readonly AgentCapabilityId[]; digest: string;
}
export interface AgentOperationContext extends ResourceFlowContext {
 agentId: string; revisionDigest: string; deploymentId: string; deploymentDigest: string;
}
export interface AgentVerificationRequest { operationId: string; agentId: string; revisionDigest: string; environmentPhysicalId: string; scope: string }
export interface AgentCapabilityObservation { id: AgentCapabilityId; status: 'supported' | 'unsupported' | 'unknown'; proof?: FlowReceipt }
export interface AgentEnvironmentVerification extends VerificationResult {
 request: AgentVerificationRequest; capabilities: readonly AgentCapabilityObservation[];
}
/** Host-owned primitives. The native lifecycle, not an adapter, decides the next stage. */
export interface AgentEnvironmentAdapters {
 create?(context: AgentOperationContext): Promise<ResourceHandle>;
 find(context: AgentOperationContext): Promise<ResourceHandle>;
 resolveDetails(resource: ResourceHandle, profileId: string | undefined, context: AgentOperationContext): Promise<ConnectionDetails | undefined>;
 validate(resource: ResourceHandle, details: ConnectionDetails | undefined, context: AgentOperationContext): Promise<void>;
 connect(resource: ResourceHandle, details: ConnectionDetails, context: AgentOperationContext): Promise<FlowReceipt>;
 verify(resource: ResourceHandle, details: ConnectionDetails, connection: FlowReceipt, context: AgentOperationContext): Promise<AgentEnvironmentVerification>;
}
export interface AgentCapabilityState extends AgentCapabilityObservation { source: 'unmeasured' | 'native-verification' }
export interface AgentReadinessState {
 version: 1; kind: 'agent-readiness'; definition: AgentDeployment; revision: AgentRevision;
 status: 'idle' | 'running' | 'paused' | 'ready' | 'failed' | 'incomplete'; ready: boolean;
 capabilities: readonly AgentCapabilityState[]; flow: ResourceFlowState;
}
