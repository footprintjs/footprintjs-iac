import type { Stack } from '../types.ts';
import { fingerprint } from '../util.ts';
import { freeze } from './data.ts';
import { graphBody, savedDigest } from './artifact.ts';
import type { InfraGraph } from './types.ts';

/** JSON round trips are supported. The returned artifact is detached and deeply frozen. */
export function validateInfraGraph(input: unknown): InfraGraph {
  const body = graphBody(input);
  const digest = savedDigest(input);
  if (fingerprint(body) !== digest) throw new Error('Infra graph digest mismatch');
  return freeze({ ...body, digest });
}
export const readInfraGraph = validateInfraGraph;

const markers = ['kind', 'version', 'boundaries', 'memberships', 'relations', 'digest'] as const;
/** A malformed or tampered graph envelope cannot silently fall back to plain Stack handling. */
export function isGraphEnvelope(input: unknown): boolean {
  return input !== null && typeof input === 'object' && markers.some(key => key in input);
}
export function assertExecutableGraph(stack: Stack): void {
  if (!isGraphEnvelope(stack)) return;
  const graph = validateInfraGraph(stack);
  for (const boundary of graph.boundaries) {
    const required = boundary.requirements?.find(requirement => requirement.mode === 'required');
    if (required) throw new Error(`Unsupported required boundary enforcement: ${boundary.id}/${required.kind}`);
  }
}
/** Preserve the envelope when consumed through Stack so execution still checks graph requirements. */
export function toStack(input: InfraGraph): Stack {
  return validateInfraGraph(input);
}
