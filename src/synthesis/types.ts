import type { CombinedRecorder, EmitEvent, EmitRecorder, FlowChart, RuntimeSnapshot } from 'footprintjs';
import type { InfraGraph } from '../graph/types.ts';
import type { JsonObject } from '../types.ts';

export type OutputFormat = 'json' | 'yaml';
export interface ArtifactFile { path: string; mediaType: string; content: string; sha256: string }
export interface ArtifactMapping {
  resourceId: string;
  nativeId: string;
  nativePath: string;
  /** The tracked synthesis state key. This is resource-level provenance. */
  sourceKey: string;
  capabilityId?: string;
  capabilityPath?: string;
  designDigest?: string;
}
export interface OutputArtifact {
  adapterId: string;
  format: OutputFormat;
  graphDigest: string;
  files: ArtifactFile[];
  mappings: ArtifactMapping[];
  limitations: string[];
  validation: 'structural';
}
/** A trusted output projection; finalize is an explicit checked compilation step. */
export interface OutputRecorder extends EmitRecorder { finalize(): OutputArtifact }
export interface OutputAdapter { id: string; create(graph: InfraGraph): OutputRecorder }
export interface SynthesisOptions { outputs: readonly OutputAdapter[]; recorders?: readonly CombinedRecorder[] }
export interface SynthesisEvidence {
  snapshot: RuntimeSnapshot;
  structure: FlowChart['buildTimeStructure'];
  controlDeps: Record<string, unknown>;
  decisions: unknown;
  narrative: unknown;
}
export interface SynthesisResult extends SynthesisEvidence {
  kind: 'synthesis-result';
  version: 1;
  graphDigest: string;
  artifacts: OutputArtifact[];
}
export interface GuardedOutput {
  recorder: EmitRecorder;
  finalize(): OutputArtifact;
}
export type SynthesisState = Record<string, unknown>;
export const RESOURCE_EVENT = 'iac.synthesis.resource';
export interface ResourceEmission { resource: JsonObject }
export type ResourceEvent = EmitEvent & { payload: ResourceEmission };
