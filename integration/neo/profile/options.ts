import type { JsonObject } from '../../../src/types.ts';
import { jsonCopy, keys, object } from '../../../src/graph/data.ts';
import type { SupportContext } from '../../../src/binding/types.ts';
import { NEO_NAMESPACE } from '../stack.ts';

export interface NeoImages { nodeImage: string; pythonImage: string }
export interface NeoKubernetesOptions { context: string; nodeImage?: string; pythonImage?: string }
export function imageReference(value: unknown): string {
  // Narrow local image syntax. The manifest always retains imagePullPolicy: Never.
  if (typeof value !== 'string' || value.length > 256
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(value)) {
    throw new Error('Neo image must be an explicit cached local image reference without credentials');
  }
  return value;
}
export function readOptions(input: NeoKubernetesOptions): NeoKubernetesOptions & NeoImages {
  const row = object(jsonCopy(input), 'Neo Kubernetes profile options');
  keys(row, ['context', 'nodeImage', 'pythonImage'], 'Neo Kubernetes profile option');
  if (typeof row.context !== 'string' || !row.context.trim() || row.context !== row.context.trim()
    || row.context.startsWith('-') || row.context.length > 256 || /[\x00-\x1f\x7f]/.test(row.context)) {
    throw new Error('Neo Kubernetes profile requires an explicit valid context');
  }
  return {
    context: row.context,
    nodeImage: imageReference(row.nodeImage ?? 'footprint-iac/neo-node:local'),
    pythonImage: imageReference(row.pythonImage ?? 'footprint-iac/neo-python:local'),
  };
}
export function assertNeoTarget(context: SupportContext): void {
  const target = context.target.properties;
  if (!target || target.namespace !== NEO_NAMESPACE || typeof target.context !== 'string'
    || !target.context.trim() || target.fixture !== 'neo-local-ephemeral') throw new Error('Neo profile target is not the explicit local fixture');
}
export function artifactImages(input: unknown): NeoImages {
  const row = object(jsonCopy(input), 'Neo fixture artifact');
  keys(row, ['kind', 'nodeImage', 'pythonImage'], 'Neo fixture artifact');
  if (row.kind !== 'neo-local-fixture') throw new Error('Expected the explicitly packaged Neo local fixture');
  return { nodeImage: imageReference(row.nodeImage), pythonImage: imageReference(row.pythonImage) };
}
