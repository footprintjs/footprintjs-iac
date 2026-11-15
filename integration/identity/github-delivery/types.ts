import type { ApplyResult, InfraGraph } from '../../../src/index.ts';
import type { DeliverySource, SourceAdapter } from '../../../src/delivery/types.ts';
import type { DeploymentEvent, DeploymentSnapshot } from '../../../src/progress/index.ts';
import type { ConnectionRunResult, ConnectionSnapshot } from '../../../src/connections/index.ts';
import type { IdentityRunResult, IdentitySnapshot } from '../../../src/identity/index.ts';
import type { MasterReview, MasterState, SystemRevision } from '../../../src/master/index.ts';
import type { IdentityTarget } from '../target.ts';
import type { NeoImageBuildOptions, buildNeoImages } from '../build-neo-images.ts';
import type { NeoFlowVerificationOptions } from '../resource-flow-verify.ts';
import type {KubernetesAssessmentTransport} from '../../../src/change-assessment/kubernetes.ts';
import type {ChangeAssessmentReport,ChangeAssessmentState} from '../../../src/change-assessment/types.ts';

export interface NeoDeliveryBaseline { graph: InfraGraph; result: ApplyResult; events: readonly DeploymentEvent[] }
export type NeoDeliveryObservation =
  | { kind:'assessment';graph:InfraGraph;phase:'plan'|'revalidate';status:'checking'|'checked'|'blocked';report?:ChangeAssessmentReport;recording?:ChangeAssessmentState['recording'];error?:string }
  | { kind: 'plan'; graph: InfraGraph; review: MasterReview; master: MasterState }
  | { kind: 'deployment'; graph: InfraGraph; snapshot: DeploymentSnapshot; result?: ApplyResult }
  | { kind: 'connections'; graph: InfraGraph; snapshot: ConnectionSnapshot; result?: ConnectionRunResult }
  | { kind: 'identity'; graph: InfraGraph; snapshot: IdentitySnapshot; result?: IdentityRunResult }
  | { kind: 'applied'; target: IdentityTarget; graph: InfraGraph; revision: SystemRevision; master: MasterState };

/** Host-only configuration. Browser requests cannot supply any of these dependencies or paths. */
export interface NeoGithubDeliveryOptions {
  targetPath: string;
  source: DeliverySource;
  sourceAdapter: SourceAdapter;
  id?: string;
  loadTarget?: (path: string) => Promise<IdentityTarget>;
  buildImages?: typeof buildNeoImages;
  buildOptions?: NeoImageBuildOptions;
  checks?: NeoFlowVerificationOptions;
  restoreForward?: (target: IdentityTarget) => Promise<void>;
  /** Trusted host test/transport seam. No browser input supplies providers or credentials. */
  assessmentTransport?: (target:IdentityTarget)=>Promise<KubernetesAssessmentTransport>;
}
