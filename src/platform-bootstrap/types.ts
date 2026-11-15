import type { HostFactsSnapshot, HostOperationContext } from '../platform-access/types.ts';
import type { FlowReceipt, ResourceHandle, VerificationResult } from '../resource-flow/types.ts';

/** Desired topology is intent. Discovery of one machine never invents more nodes. */
export interface ClusterTopologyIntent {
  version: string;
  nodes: { hostId: string; role: 'control-plane' | 'worker' }[];
  podNetworkCidr?: string;
  serviceNetworkCidr?: string;
}
export interface BootstrapIntent {
  id: string;
  mode: 'create' | 'existing';
  topology: ClusterTopologyIntent;
}
export interface BootstrapContext extends HostOperationContext {
  /** A completed action is retained across native revalidation and never sent twice. */
  completedActionIds: readonly string[];
  /** Identity observed immediately after our initialization action, retained by the workflow. */
  resource?: ResourceHandle;
}
export interface BootstrapAction {
  id: string;
  hostId: string;
  phase: 'prepare' | 'initialize' | 'network' | 'join';
  /** Commits to an immutable host-owned action registration, never a shell string. */
  actionDigest: string;
}
export interface BootstrapPlan {
  kind: 'cluster-bootstrap-plan';
  version: 1;
  adapterId: string;
  scope: string;
  mode: 'create' | 'existing';
  intentDigest: string;
  configurationDigest: string;
  strategy: { id: string; digest: string };
  hostIdentities: { hostId: string; identityDigest: string }[];
  existingResource?: ResourceHandle;
  /** Full acquisition evidence is recorded separately from the stable operation plan. */
  observationsDigest: string;
  /** Safe measured prerequisite facts; private diagnostics and recipe bytes are excluded. */
  preparations?: HostPreparationAssessment[];
  disposition: 'create' | 'connect' | 'blocked';
  reasons: string[];
  actions: BootstrapAction[];
  /** Seals semantics, registered actions and physical identities, excluding observationsDigest. */
  digest: string;
}
export interface BootstrapAssessmentInput {
  adapterId: string;
  scope: string;
  configurationDigest: string;
  intent: BootstrapIntent;
  facts: readonly HostFactsSnapshot[];
  observation: ClusterObservation;
  /** Provider-owned compatibility facts. Unknowns are represented by safe reason codes. */
  capabilities: { supported: boolean; reasons: string[] };
  actions: readonly BootstrapAction[];
  preparations?: readonly HostPreparationAssessment[];
}
/** Pure policy. The lifecycle adapter performs common admission after any custom strategy. */
export interface ClusterBootstrapStrategy {
  readonly id: string;
  readonly digest: string;
  assess(input: BootstrapAssessmentInput): BootstrapPlan;
}
export interface BootstrapRevalidation {
  valid: boolean;
  planDigest: string;
  observationsDigest: string;
  reasons: string[];
  preparations?: HostPreparationAssessment[];
}
export interface BootstrapActionReceipt {
  id: string;
  actionId: string;
  hostId: string;
  status: 'completed';
  receipt: FlowReceipt;
  resource?: ResourceHandle;
}
export interface HostPreparationAssessment {
  hostId: string;
  identityDigest: string;
  recipeDigest: string;
  status: 'ready' | 'preparable' | 'blocked' | 'unknown';
  actions: BootstrapAction[];
  checks: { id: string; passed: boolean }[];
  observedAt: number;
  digest: string;
}
export interface HostPreparationPort {
  readonly id: string;
  readonly recipeDigest: string;
  inspect(facts: HostFactsSnapshot, intent: BootstrapIntent, context: BootstrapContext): Promise<HostPreparationAssessment>;
}
export interface ClusterObservation {
  status: 'present' | 'absent' | 'unknown';
  resource?: ResourceHandle;
  /** Actual API-server version from this target. Missing is unknown, not the desired version. */
  platformVersion?: string;
}
export interface PublishedClusterAccess { profileId: string; receipt?: FlowReceipt }

/** Host-owned ports hold credentials, commands and private kubeconfig publication outside recordings. */
export interface ClusterConnectionPort {
  inspect(context: BootstrapContext): Promise<ClusterObservation>;
  publishAccess(resource: ResourceHandle, context: BootstrapContext): Promise<PublishedClusterAccess | undefined>;
  verify(resource: ResourceHandle, profileId: string, context: BootstrapContext): Promise<VerificationResult>;
}

/** Execute through the recorded platform workflow: it persists intent and revalidates before each effect. */
export interface ClusterLifecycleAdapter {
  readonly id: string;
  readonly scope: string;
  assess(intent: BootstrapIntent, facts: readonly HostFactsSnapshot[], context: BootstrapContext): Promise<BootstrapPlan>;
  revalidate(plan: BootstrapPlan, intent: BootstrapIntent, facts: readonly HostFactsSnapshot[], context: BootstrapContext): Promise<BootstrapRevalidation>;
  executeAction(plan: BootstrapPlan, actionId: string, context: BootstrapContext): Promise<BootstrapActionReceipt>;
  find(context: BootstrapContext): Promise<ClusterObservation>;
  publishAccess(resource: ResourceHandle, context: BootstrapContext): Promise<PublishedClusterAccess | undefined>;
  verify(resource: ResourceHandle, profileId: string, context: BootstrapContext): Promise<VerificationResult>;
}
