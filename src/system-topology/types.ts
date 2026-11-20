import type { CommunicationDetails } from '../graph/communication.ts';
import type { AdapterFlowPhase, AdapterFlowStatus } from '../adapter-flow/types.ts';
/** Safe declarative architecture. No addresses, credentials, commands or arbitrary icon URLs. */
export type TopologyCategory = 'compute' | 'storage' | 'network' | 'identity' | 'other';
export type TopologyOrigin = 'existing' | 'deployment' | 'embedded';
export interface TopologyTechnology {
    id: string;
    label: string;
    version?: string;
}
export interface TopologyBindings {
    resourceIds: readonly string[];
    componentIds?: readonly string[];
    checkIds?: readonly string[];
}
export interface TopologyBoundary {
    id: string;
    label: string;
    kind: 'host' | 'server' | 'vm' | 'cluster' | 'runtime' | 'namespace' | 'pod' | 'container' | 'region' | 'security' | 'group';
    parentId?: string;
    technology?: TopologyTechnology;
    bindings?: TopologyBindings;
}
export interface TopologyNode {
    id: string;
    label: string;
    category: TopologyCategory;
    origin: TopologyOrigin;
    boundaryId?: string;
    technology?: TopologyTechnology;
    description?: string;
    bindings: TopologyBindings;
}
export interface TopologyConnection {
  details?: CommunicationDetails;
    id: string;
    from: string;
    to: string;
    kind: 'communicatesWith' | 'dependsOn';
    label?: string;
    checkIds?: readonly string[];
}
export interface SystemTopologyInput {
    id: string;
    label: string;
    nodes: readonly TopologyNode[];
    boundaries: readonly TopologyBoundary[];
    connections: readonly TopologyConnection[];
}
export interface SystemTopologyBinding {
    targetId: string;
    graphDigest: string;
}
export interface SystemTopologyDefinition extends SystemTopologyInput {
    version: 1;
    kind: 'system-topology';
    binding: SystemTopologyBinding;
    digest: string;
}
export interface TopologyEvidenceReference {
    kind: 'adapter' | 'deployment' | 'check';
    runId: string;
    runtimeStageId?: string;
    complete: boolean;
}
export interface TopologyResourceObservation {
    id: string;
    status: 'pending' | 'deploying' | 'ready' | 'failed' | 'skipped' | 'deleted';
    action?: 'create' | 'update' | 'verify' | 'delete' | 'noop';
    evidence: TopologyEvidenceReference;
}
/** An actual measured unit outcome, not a copy of its service-group readiness. */
export interface TopologyComponentObservation {
    id: string;
    resourceId: string;
    phase: 'inspect' | 'revalidate' | 'configure' | 'reload' | 'start' | 'apply' | 'observe';
    status: 'running' | 'passed' | 'failed' | 'unknown';
    installed?: boolean;
    running?: boolean;
    evidence: TopologyEvidenceReference;
}
/** Hosts admit the owning native check receipt before projecting these safe rows. */
export interface TopologyCheckObservation {
    id: string;
    status: 'checking' | 'passed' | 'failed' | 'unknown';
    evidence: TopologyEvidenceReference;
}
/** Observed execution metadata, separate from installed/running/verified facts. */
export interface TopologyActionObservation {
    resourceId: string;
    componentId?: string;
    phase: AdapterFlowPhase;
    status: AdapterFlowStatus;
    evidence: TopologyEvidenceReference & { kind: 'adapter'; runtimeStageId: string };
}
export interface TopologyNodeAction extends TopologyActionObservation {
    scope: 'component' | 'shared-resource';
    label: string;
}
export interface SystemTopologyObservations extends SystemTopologyBinding {
    definitionDigest: string;
    configurationDigest: string;
    resources: readonly TopologyResourceObservation[];
    components: readonly TopologyComponentObservation[];
    checks: readonly TopologyCheckObservation[];
    actions?: readonly TopologyActionObservation[];
}
export type TopologyStatus = 'pending' | 'installing' | 'starting' | 'checking' | 'connected' | 'ready' | 'failed' | 'unknown' | 'incomplete' | 'skipped' | 'removed';
export type TopologyFact = 'confirmed' | 'refuted' | 'unknown';
export interface TopologyNodeView extends TopologyNode {
    actions?: readonly TopologyNodeAction[];
    status: TopologyStatus;
    statusLabel: string;
    originLabel: string;
    facts: {
        installed: TopologyFact;
        running: TopologyFact;
        connected: TopologyFact;
    };
    evidenceScope: 'component' | 'checks' | 'shared-resource' | 'none';
    progress: {
        completed: number;
        total: number;
        indeterminate: boolean;
    };
    evidence: readonly TopologyEvidenceReference[];
    limitations: readonly string[];
}
export interface TopologyBoundaryView extends TopologyBoundary {
    status: TopologyStatus;
    observed: boolean;
    progress: {
        completed: number;
        total: number;
        indeterminate: boolean;
    };
    evidence: readonly TopologyEvidenceReference[];
}
export interface TopologyConnectionView extends TopologyConnection {
    status: 'untested' | 'checking' | 'connected' | 'failed' | 'unknown' | 'incomplete';
    evidence: readonly TopologyEvidenceReference[];
}
export interface SystemTopologyView {
    version: 1;
    kind: 'system-topology-view';
    definition: SystemTopologyDefinition;
    observations: SystemTopologyObservations;
    nodes: readonly TopologyNodeView[];
    boundaries: readonly TopologyBoundaryView[];
    connections: readonly TopologyConnectionView[];
    limitations: readonly string[];
}
