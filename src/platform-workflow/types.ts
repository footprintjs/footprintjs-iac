import type { CombinedRecorder } from 'footprintjs';
import type { HostDiscoveryPort, HostFactsSnapshot, HostRef } from '../platform-access/types.ts';
import type { BootstrapActionReceipt, BootstrapIntent, BootstrapPlan, ClusterLifecycleAdapter } from '../platform-bootstrap/types.ts';
import type { ResourceFlowProfiles } from '../resource-flow/profile-catalog.ts';
import type { ConnectionDetails, ConnectionProfileChoice, FlowReceipt, ResourceFlowContext, ResourceFlowDefinition, ResourceFlowState, ResourceHandle } from '../resource-flow/types.ts';

export interface PlatformActionState {
  id: string;
  hostId: string;
  actionDigest: string;
  status: 'pending' | 'started' | 'completed' | 'uncertain';
  receipt?: BootstrapActionReceipt;
}
export interface PlatformRecording {
  phase: 'assessment' | 'execution';
  runId: string;
  evidencePath: string;
  tracePath: string;
  complete: boolean;
  status: 'passed' | 'paused' | 'failed' | 'incomplete';
  resumedFromRunId?: string;
}
export interface PlatformBootstrapState {
  version: 1;
  kind: 'platform-bootstrap-state';
  bindingDigest: string;
  executionId: string | null;
  status: 'idle' | 'running' | 'paused' | 'passed' | 'blocked' | 'failed' | 'incomplete';
  facts?: HostFactsSnapshot[];
  plan?: BootstrapPlan;
  actions: PlatformActionState[];
  resource?: ResourceHandle;
  accessProfileId?: string;
  publicationStatus?: 'started' | 'completed' | 'uncertain';
  recordings: PlatformRecording[];
  pause?: { token: string; prompt: string; profiles: ConnectionProfileChoice[] };
  errorCode?: string;
}
export interface PlatformWorkflowState {
  version: 1;
  kind: 'platform-workflow-state';
  status: PlatformBootstrapState['status'];
  bootstrap: PlatformBootstrapState;
  connection?: ResourceFlowState;
}
export interface PlatformWorkflowOptions {
  /** Its target scope must equal lifecycle.scope, and mode must equal intent.mode. */
  definition: ResourceFlowDefinition;
  intent: BootstrapIntent;
  hosts: readonly HostRef[];
  /** Unnecessary for existing clusters when hosts/topology.nodes are empty. */
  discovery?: HostDiscoveryPort;
  lifecycle: ClusterLifecycleAdapter;
  /** Host-owned private state directory. JSON requests never choose this path. */
  directory: string;
  /** Measured facts must be fresh before an installation action. Default 30 seconds, at most 5 minutes. */
  maxFactAgeMs?: number;
  /** A dynamic catalog lets bootstrap publish a new immutable Kubernetes profile. */
  profiles: ResourceFlowProfiles;
  profileCatalogId?: string;
  resolveDetails(resource: ResourceHandle, profileId: string, context: ResourceFlowContext): Promise<ConnectionDetails | undefined>;
  connect(resource: ResourceHandle, details: ConnectionDetails, context: ResourceFlowContext): Promise<FlowReceipt>;
  recorders?: readonly CombinedRecorder[];
}
