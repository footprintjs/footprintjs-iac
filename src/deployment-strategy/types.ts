import type { CheckRunner } from '../checks/types.ts';
import type { CombinedRecorder } from 'footprintjs';
import type { DeploymentChartObserver } from '../progress/chart.ts';
import type {MasterSource,MasterArtifact} from '../master/types.ts';

/** A host-registered deployment controller. A request selects its ID, never code or credentials. */
export interface DeploymentStrategyAdapter {
  readonly id: string;
  readonly kind: string;
  plan(input: { revisionId: string }): Promise<{ ok: boolean; reviewId?: string }>;
  apply(reviewId: string): Promise<{ ok: boolean; promoted: boolean; status: string }>;
  snapshot(): Promise<unknown>;
}
export interface DeploymentCheckBinding { runner: CheckRunner; suiteId: string; requiredCheckIds: readonly string[] }
export interface SystemdUnitBinding {
  id: string; name: string; fragmentPath: string; configurationDigest: string;
  dependsOn?: readonly string[];
}
export interface SystemdUnitObservation {
  name: string; exists: boolean; fragmentPath: string | null; fragmentDigest: string | null; configurationDigest: string | null;
  activeState: string; invocationId: string | null;
  /** Measured from the active process, not copied from a requested release. */
  appliedSpecDigest: string | null;
}
export interface SystemdHostObservation { identityDigest: string; units: SystemdUnitObservation[] }
export interface SystemdUnitApplyRequest { unit: string; desiredSpecDigest: string; releaseDigest: string }
export interface SystemdGroupApplyRequest { units: readonly string[]; desiredSpecDigest: string; releaseDigest: string }
export interface SystemdGroupApplyContext { operationId:string; expectedIdentityDigest:string; expectedUnits:readonly SystemdUnitObservation[] }
export interface SystemdApplyContext { operationId: string; expectedIdentityDigest: string; expectedUnit: SystemdUnitObservation }
/** Private trusted host code; Local/SSH/API implementations may share this port. */
export interface SystemdDeploymentHost {
  inspect(): Promise<SystemdHostObservation>;
  applyUnit?(request: SystemdUnitApplyRequest, context: SystemdApplyContext): Promise<void>;
  applyUnits?(request: SystemdGroupApplyRequest, context: SystemdGroupApplyContext): Promise<void>;
}
export interface SystemdDeploymentOptions {
  id: string; stack: string; stateDirectory: string; releaseDigest: string;
  /** Coupled units restart in one systemd transaction. Independent mode requires explicit selection. */
  transaction?: 'group' | 'independent';
  registration: { hostId: string; scope: string; identityDigest: string };
  units: readonly SystemdUnitBinding[];
  host: SystemdDeploymentHost;
  preflightChecks: DeploymentCheckBinding;
  applicationChecks: DeploymentCheckBinding;
  /** Non-secret provenance, captured and validated before observation and sealed into each Master revision. */
  source?: MasterSource;
  artifacts?: readonly MasterArtifact[];
  /** Native engine progress observers; these do not grant deployment authority. */
  recorders?: CombinedRecorder[];
  chartObservers?: DeploymentChartObserver[];
}
export type DeploymentStrategyDescription = { id: string; kind: string };
