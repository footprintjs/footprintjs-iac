import type { ConnectionSnapshot } from '../../src/connections/types.ts';
import type { IdentitySnapshot } from '../../src/identity/types.ts';
import type { DeploymentSnapshot } from '../../src/progress/types.ts';
import type { ResourceFlowState } from '../../src/resource-flow/types.ts';
import type { Action } from '../../src/types.ts';

/** Browser-safe measured feed. Child native runs remain distinct from the parent lifecycle. */
export interface NeoFlowCorrelation {
  executionId: string;
  definitionDigest: string;
  purpose: 'verify' | 'recheck';
}
export interface NeoFlowApplyObservation {
  phase: 'acquire' | 'connect';
  executionId: string;
  definitionDigest: string;
  origin: 'live' | 'evidence';
  snapshot: DeploymentSnapshot;
  result?: { ok: boolean; runId: string; evidencePath: string; tracePath?: string;
    actions: { resourceId: string; action: Action }[]; chartPublished: boolean; traceFlushed: boolean };
}
export interface NeoFlowSourceObservation {
  mode: 'create' | 'existing';
  executionId: string;
  definitionDigest: string;
  physicalId: string;
  observedAt: number;
  resources: { resourceId: 'identity-directory' | 'identity-provider'; physicalId: string; running: boolean }[];
  /** Measured lookup is correlated with its actual parent Acquire event, never a fabricated apply run. */
  parentAcquire?: { runtimeStageId: string; runId?: string };
}
export interface NeoFlowConnectionObservation extends NeoFlowCorrelation {
  origin: 'live' | 'evidence';
  snapshot: ConnectionSnapshot;
  result?: { ok: boolean; runId: string; evidencePath: string; tracePath?: string; traceFlushed: boolean };
}
export interface NeoFlowIdentityObservationFeed extends NeoFlowCorrelation {
  origin: 'live' | 'evidence';
  snapshot: IdentitySnapshot;
  result?: { ok: boolean; runId: string; evidencePath: string; tracePath?: string; traceFlushed: boolean };
}
export interface NeoResourceFlowObservation {
  version: 1;
  kind: 'neo-resource-flow-observation';
  targetId: string;
  sequence: number;
  parent: ResourceFlowState;
  deployments: NeoFlowApplyObservation[];
  source?: NeoFlowSourceObservation;
  connections: NeoFlowConnectionObservation[];
  identities: NeoFlowIdentityObservationFeed[];
  /** Missing or invalid retained observations remain unknown; reading never contacts providers. */
  retainedEvidence: 'none' | 'complete' | 'incomplete';
  subscriberFailures: number;
}
export interface NeoResourceFlowObservationSource {
  snapshot(): Promise<NeoResourceFlowObservation>;
  subscribe(listener: (snapshot: NeoResourceFlowObservation) => void): () => void;
}
