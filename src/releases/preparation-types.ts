import type { DeliveryDefinition, DeliveryEvent, DeliveryRecording, DeliveryResults, DeliveryStage, SourceRevision } from '../delivery/types.ts';
import type { ReleaseManifest } from './types.ts';

export const RELEASE_BUILD_STAGES = ['resolve','fetch','build','publish'] as const;
/** target binds the build/artifact host, never an environment to deploy. */
export type ReleasePreparationDefinition = DeliveryDefinition;
export interface ReleasePreparationState {
  version: 1; kind: 'release-preparation'; definition: ReleasePreparationDefinition; definitionDigest: string;
  executionId: string | null; status: 'idle'|'running'|'passed'|'failed'|'incomplete';
  stages: DeliveryStage[]; events: DeliveryEvent[];
  results: Pick<DeliveryResults,'revision'|'source'|'build'|'publication'>;
  recordings: DeliveryRecording[]; release?: ReleaseManifest; error?: string;
  expectedRevision?: SourceRevision;
}
