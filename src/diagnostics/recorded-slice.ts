import { keysReadFromExecutionTree, sliceForKey, sliceToJSON, type ControlDependency, type VariableSlice } from 'foottrace';
import { admitRecordedQuery, RecordedQueryError, recordedQueryOptions } from './recorded-admission.ts';
import type { RecordedDependencyInput, RecordedDependencyOptions, RecordedDependencyResult, RecordedDependencySummary } from './recorded-types.ts';

const baseLimitations = [
  'Recorded candidate dependencies do not establish a physical or semantic root cause.',
  'This query inspects one recorded scope; child logs, external calls and earlier pause segments require their own evidence.',
] as const;
export function inspectRecordedDependencies(input: RecordedDependencyInput, key: string,
  options?: RecordedDependencyOptions): { slice: VariableSlice; result: RecordedDependencyResult } {
  const selected = admitRecordedQuery(input, key), budget = recordedQueryOptions(options);
  const reads = keysReadFromExecutionTree(selected.tree);
  const slice = sliceForKey(selected.log, key, reads, {
    edgeAttribution: 'per-write', maxNodes: budget.maxNodes, maxDepth: budget.maxDepth,
    ...(selected.control ? { controlDeps: (id: string) => Object.hasOwn(selected.control!, id) ? selected.control![id] as ControlDependency : undefined } : {}),
  });
  const dependencies = sliceToJSON(slice), edges = dependencies.edges ?? [];
  if (edges.length > budget.maxEdges) throw new RecordedQueryError('query-limit');
  const summary: RecordedDependencySummary = { nodes: Object.keys(dependencies.nodes ?? {}).length,
    dataEdges: edges.filter(edge => edge.kind === 'data').length, controlEdges: edges.filter(edge => edge.kind === 'control').length,
    partialWriteEdges: edges.filter(edge => edge.builtOn !== undefined).length,
    possibleSourceEdges: edges.filter(edge => edge.overlap !== undefined).length };
  const limitations: string[] = [...baseLimitations];
  if (selected.provenance.withoutReadPrefix) limitations.push('Writes without per-write provenance use the recorded stage-level read set conservatively.');
  if (reads.coverage?.stepsWithReads === 0) limitations.push('No retained read keys were found; unrecorded reads and a genuine absence of reads cannot be distinguished.');
  if (!selected.control) limitations.push('Control dependencies were not supplied; a missing control edge is not evidence that no decision governed the step.');
  if (summary.possibleSourceEdges) limitations.push('Some recorded read windows have several possible sources; those edges remain uncertain.');
  if (dependencies.truncated) limitations.push('The dependency walk reached its node or depth limit; additional sources may remain outside the answer.');
  const order: { nodeId: string; commitIndex: number }[] = [], ordered = new Set<string>();
  selected.log.forEach((commit, commitIndex) => {
    const nodeId = commit.runtimeStageId;
    if (nodeId && dependencies.nodes && Object.hasOwn(dependencies.nodes, nodeId) && !ordered.has(nodeId)) {
      ordered.add(nodeId); order.push({ nodeId, commitIndex });
    }
  });
  const result: RecordedDependencyResult = { version: 1, kind: 'recorded-dependencies', runId: selected.runId, key,
    status: slice.root ? 'available' : 'missing', provenance: selected.provenance,
    ...(reads.coverage ? { coverage: reads.coverage } : {}), dependencies, order, summary, limitations };
  if (new TextEncoder().encode(JSON.stringify(result)).length > budget.maxOutputBytes) throw new RecordedQueryError('query-limit');
  return { slice, result };
}
export function unavailableRecordedDependencies(key: unknown, code: RecordedQueryError['code']): RecordedDependencyResult {
  return { version: 1, kind: 'recorded-dependencies', runId: null, key: typeof key === 'string' && key.length <= 2048 && !key.includes('\u0000') ? key : '',
    status: 'unavailable', provenance: { requested: 'per-write', recorded: 'unknown', withReadPrefix: 0, withoutReadPrefix: 0 },
    order: [],
    summary: { nodes: 0, dataEdges: 0, controlEdges: 0, partialWriteEdges: 0, possibleSourceEdges: 0 },
    limitations: [code === 'query-limit' ? 'The recording exceeds this bounded query; no partial answer is presented as complete.' : 'The supplied recording could not be inspected; missing evidence remains unknown.'], error: code };
}
