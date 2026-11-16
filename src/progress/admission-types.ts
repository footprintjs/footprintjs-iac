import type { RunEvidence } from '../evidence.ts';
import type { InfraGraph } from '../graph/types.ts';
import type { Plan } from '../types.ts';
import type { DeploymentChart } from './chart.ts';
import type { DeploymentEvent } from './types.ts';
export interface DeploymentProgressAdmissionInput {
  evidence: RunEvidence; graph: InfraGraph; plan: Plan; runId: string; ok: boolean;
  chart?: DeploymentChart; recorder?: unknown;
}
/** Historic commit replay retains native identity but cannot invent event timestamps. */
export type AdmittedDeploymentEvent = Omit<DeploymentEvent, 'timestamp' | 'message'> & { readonly timestamp?: number };
export interface AdmittedDeploymentProgress {
  events: readonly AdmittedDeploymentEvent[];
  resources: readonly (AdmittedDeploymentEvent & { readonly id: string })[];
  progressCapture: { source: 'native-recorder' | 'commit-fallback'; observedStarts: boolean; warning?: string };
}
