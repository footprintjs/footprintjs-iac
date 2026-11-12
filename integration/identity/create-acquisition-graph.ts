import { createIdentityGraph } from './graph.ts';
import type { IdentityTarget } from './target.ts';

/** Creating identity never deploys or configures its Neo consumer. */
export function createNeoAcquisitionGraph(target: IdentityTarget) {
  return createIdentityGraph(target);
}
