import { capabilityOrigins } from './origins.ts';
import { sliceToJSON } from 'foottrace';
import { backwalk, type RunEvidence } from '../evidence.ts';
import { validateInfraGraph } from '../graph/validation.ts';

function recordedFailure(evidence: RunEvidence): { resourceId: string; message: string; messageTruncated: boolean } | null {
  const failure: unknown = evidence.snapshot.sharedState.failure;
  if (!failure || typeof failure !== 'object') return null;
  const row = failure as Record<string, unknown>;
  if (typeof row.resourceId !== 'string' || typeof row.message !== 'string') return null;
  return { resourceId: row.resourceId, message: row.message.slice(0, 4096), messageTruncated: row.message.length > 4096 };
}

/** Structured, read-only agent interface. It reports recorded dependencies, not an external root-cause verdict. */
export function explainRun(evidence: RunEvidence, key = 'failure') {
  const failure = recordedFailure(evidence);
  const graph = evidence.graph === undefined ? undefined : validateInfraGraph(evidence.graph);
  if (graph && graph.name !== evidence.stack) throw new Error('Recorded graph belongs to another stack');
  const explanation = backwalk(evidence, key);
  const memberships = graph?.memberships.filter(member => member.resourceId === failure?.resourceId) ?? [];
  const shown = memberships.slice(0, 32).map(member => {
    const boundary = graph!.boundaries.find(candidate => candidate.id === member.boundaryId)!;
    return { id: boundary.id, kind: boundary.kind, ...(boundary.label === undefined ? {} : { label: boundary.label }), status: 'declared' as const };
  });
  return {
    version: 1 as const, kind: 'recorded-explanation' as const,
    runId: evidence.runId, stack: evidence.stack, key,
    failure,
    ...(graph ? { design: {
      digest: graph.digest,
      ...(failure ? { resourceId: failure.resourceId } : {}),
      boundaries: shown, omittedBoundaryCount: memberships.length - shown.length,
      ...(failure ? { capabilities: capabilityOrigins(graph, failure.resourceId) } : {}),
    } } : {}),
    // The native flat serialization retains missing/truncated/coverage notes and avoids DAG duplication.
    dependencies: sliceToJSON(explanation.slice),
    ...(evidence.traceStatus ? { capture: evidence.traceStatus } : {}),
    externalRootCause: 'not-established' as const,
    limitations: [
      'The slice follows recorded candidate data and control dependencies; ordering alone does not establish a physical cause.',
      'Provider internals, planning decisions and uncaptured child tools are outside this resource-level recording.',
      'Boundary membership describes design intent; it is not proof that placement or security was enforced.',
    ],
  };
}
