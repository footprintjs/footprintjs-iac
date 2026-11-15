import type { AgentDeployment, AgentEnvironmentAdapters, AgentReadinessState } from '../types.ts';
import type { ResourceFlowProfiles } from '../../resource-flow/profile-catalog.ts';
import type { ResourceFlowSegment } from '../../resource-flow/types.ts';

export type AgentComponentKind = 'execution' | 'store' | 'context' | 'connection';
export type AgentComponentStatus = 'pending' | 'running' | 'ready' | 'failed' | 'paused' | 'incomplete' | 'skipped';
export interface AgentComponent {
 id: string; label: string; kind: AgentComponentKind; roles: readonly string[];
 mode: 'create' | 'existing'; resourceIds: readonly string[]; environmentResourceId: string;
 requiredCheckIds: readonly string[]; required: boolean; selected?: boolean; boundaryId?: string;
 storage?: 'memory' | 'persistent'; sharing?: 'shared' | 'dedicated'; physicalGroupId?: string;
}
export interface AgentRuntimeBoundary {
 id: string; label: string; kind: 'platform' | 'host' | 'namespace' | 'pod' | 'container' | 'service' | 'shared' | 'isolation';
 parentId?: string; strategy?: { id: string; label: string };
 /** Native identity/check anchor. Declaration does not establish realization or isolation. */
 realizedBy?: string; requiredCheckIds?: readonly string[];
}
export interface AgentComponentRelation {
 id: string; from: string; to: string; kind: 'order' | 'communicatesWith' | 'supports' | 'contains';
 required?: boolean; checkComponentId?: string;
}
export interface AgentComponentGraphInput {
 id: string; label: string; components: readonly AgentComponent[]; boundaries: readonly AgentRuntimeBoundary[];
 relations: readonly AgentComponentRelation[];
}
export interface AgentComponentGraph extends AgentComponentGraphInput {
 version: 1; kind: 'agent-component-graph'; deploymentDigest: string; revisionDigest: string;
 graphDigest: string; target: AgentDeployment['target']; digest: string;
}
export interface AgentComponentPorts {
 adapters: AgentEnvironmentAdapters; profiles: ResourceFlowProfiles; profileCatalogId?: string; requireProfileAtStart?: boolean;
}
export interface AgentComponentState { id: string; status: AgentComponentStatus; readiness?: AgentReadinessState }
export interface AgentComponentsState {
 version: 1; kind: 'agent-components-state'; definitionDigest: string; executionId: string | null;
 status: 'idle' | 'running' | 'ready' | 'failed' | 'paused' | 'incomplete'; ready: boolean;
 components: readonly AgentComponentState[]; segments: readonly ResourceFlowSegment[];
}
export interface AgentComponentsResumeInput { componentId: string; pauseToken: string; profileId: string }
export interface AgentBoundaryProgress {
 completed: number; total?: number; indeterminate: boolean; unit: 'stages';
}
export interface AgentBoundaryState {
 id: string; status: AgentComponentStatus; observed: boolean; progress: AgentBoundaryProgress;
 physicalResource?: { id: string; kind: string; physicalId: string; scope: string };
 recording?: { runId: string; evidencePath: string; tracePath: string; complete: true };
}
export interface AgentComponentProjection {
 definition: AgentComponentGraph; state: AgentComponentsState;
 nodes: readonly (AgentComponent & AgentComponentState & { progress: AgentBoundaryProgress })[];
 boundaries: readonly AgentBoundaryState[];
 relations: readonly (AgentComponentRelation & { status?: 'untested' | 'checking' | 'connected' | 'failed' })[];
}
