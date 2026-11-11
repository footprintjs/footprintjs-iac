import { readDeploymentChart, type DeploymentResourceStages, type NativeDeploymentStructure } from './chart.ts';

/** Planned native topology only. A preview has no run ID, progress, or execution verdict. */
export interface DeploymentSchedulePreview {
  readonly version: 1;
  readonly kind: 'deployment-schedule-preview';
  readonly stack: string;
  readonly graphDigest?: string;
  readonly structure: NativeDeploymentStructure;
  readonly resources: readonly DeploymentResourceStages[];
}

/** Admit a detached, deeply frozen preview without allowing executable or run metadata. */
export function readDeploymentSchedulePreview(input: unknown): DeploymentSchedulePreview {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid deployment schedule preview');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !['version', 'kind', 'stack', 'graphDigest', 'structure', 'resources'].includes(key)
      || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable) throw Error('Invalid deployment preview property');
  }
  const value = (key: string) => descriptors[key]?.value;
  if (value('kind') !== 'deployment-schedule-preview') throw Error('Invalid deployment preview kind');
  const chart = readDeploymentChart({ version: value('version'), runId: 'schedule-preview', stack: value('stack'),
    ...(value('graphDigest') === undefined ? {} : { graphDigest: value('graphDigest') }),
    structure: value('structure'), resources: value('resources') });
  return Object.freeze({ version: 1, kind: 'deployment-schedule-preview', stack: chart.stack,
    ...(chart.graphDigest === undefined ? {} : { graphDigest: chart.graphDigest }), structure: chart.structure, resources: chart.resources });
}
