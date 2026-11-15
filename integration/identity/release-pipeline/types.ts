import type { DeliveryPublication, SourceRevision } from '../../../src/delivery/types.ts';
import type { ReleaseManifest } from '../../../src/releases/types.ts';
import type { PipelineTarget } from '../../../src/pipeline/types.ts';
import type { NeoGithubDeliveryOptions } from '../github-delivery/types.ts';
import type { NeoFlowVerificationOptions } from '../resource-flow-verify.ts';
import type { command } from '../command.ts';
import type { loadIdentityTarget } from '../target.ts';
import type { identityEngine } from '../engine.ts';

export interface NeoPreparedRelease { manifest: ReleaseManifest; publication: DeliveryPublication; buildTargetPath?: string }
export interface NeoReleasePreparationOptions extends NeoGithubDeliveryOptions { expectedRevision?: SourceRevision }
export interface NeoReleaseEnvironment {
  id: string; label: string; targetPath: string;
  promotion: 'automatic' | 'manual'; rollback: 'disabled';
}
export interface NeoReleaseEnvironmentView { id: string; label: string; target: PipelineTarget }
/** Host-only composition. No HTTP request may construct options, target paths or private publications. */
export interface NeoReleasePipelineOptions {
  id?: string; directory?: string; environments: readonly NeoReleaseEnvironment[]; releases: readonly NeoPreparedRelease[];
  checks?: NeoFlowVerificationOptions; runner?: typeof command; loadTarget?: typeof loadIdentityTarget;
  fixtureRoot?: string; restoreForward?: NeoGithubDeliveryOptions['restoreForward'];
  engineFactory?: typeof identityEngine;
  assessmentTransport?: NeoGithubDeliveryOptions['assessmentTransport'];
}
