import type { DeliveryArtifact, DeliveryRecipe, SourceRevision } from '../delivery/types.ts';

/** The content promoted between environments. A manifest contains no host handles or credentials. */
export interface ReleaseManifest {
  kind: 'release-manifest'; schemaVersion: 1; id: string; label?: string;
  source: SourceRevision; recipe: DeliveryRecipe; artifacts: readonly DeliveryArtifact[]; digest: string;
}
export type ReleaseManifestInput = Omit<ReleaseManifest, 'kind' | 'schemaVersion' | 'digest'>;
/** A discovered source version is not a built or verified application release. */
export interface ReleaseChoice {
  id: string; label: string; version?: string;
  source: { repository: string; ref: string; commit?: string; tree?: string };
  publishedAt?: string; url?: string; manifestDigest?: string;
}
export interface ResolvedReleaseChoice extends Omit<ReleaseChoice, 'source'> { source: SourceRevision }
export interface ReleaseCatalog {
  id: string;
  list(): Promise<readonly ReleaseChoice[]>;
  resolve(id: string): Promise<ResolvedReleaseChoice>;
}
export interface ReleaseEvidenceReceipt { runId: string; evidencePath: string; tracePath: string }
