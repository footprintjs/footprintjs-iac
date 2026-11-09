import { randomUUID } from 'node:crypto';
import { freeze } from '../graph/data.ts';
import { assertExecutableGraph, validateInfraGraph } from '../graph/validation.ts';
import { INTERNAL_CONTROL_RECORDER_ID, runApplyChart } from '../execution/run-apply-chart.ts';
import { createConnectionChart } from './create-connection-chart.ts';
import { createConnectionRecorder } from './recorder.ts';
import type { ConnectionCheckOptions, ConnectionCheckRequest, ConnectionCheckResult, ConnectionRunResult } from './types.ts';

/** Real observations in a separate native chart; deployment readiness and connection health stay distinct. */
export async function checkConnections(options: ConnectionCheckOptions): Promise<ConnectionRunResult> {
  const graph = validateInfraGraph(options.graph); assertExecutableGraph(graph);
  if (!options.adapter || typeof options.adapter.check !== 'function') throw new Error('A connection adapter is required');
  const extra = [...(options.recorders ?? [])];
  if (new Set(extra.map(recorder => recorder.id)).size !== extra.length) throw new Error('Duplicate connection recorder IDs');
  if (extra.some(recorder => recorder.id === INTERNAL_CONTROL_RECORDER_ID || recorder.id === 'iac-internal-connection-progress')) {
    throw new Error('The internal connection recorder ID is reserved');
  }
  const byId = new Map(graph.resources.map(resource => [resource.id, resource]));
  const requests: ConnectionCheckRequest[] = [];
  for (const [index, relation] of graph.relations.entries()) if (relation.kind === 'communicatesWith') {
    requests.push(freeze({ connectionId: `communication:${index}`, stack: graph.name,
      from: byId.get(relation.from)!, to: byId.get(relation.to)!, relation }));
  }
  const runId = randomUUID();
  const projection = createConnectionRecorder({ id: 'iac-internal-connection-progress' });
  // Capture the selected method once; a caller cannot retarget the active run by replacing it later.
  const adapter = Object.freeze({ check: options.adapter.check.bind(options.adapter) });
  const chart = createConnectionChart(graph.digest, Object.freeze(requests), adapter, runId);
  const recorded = await runApplyChart(chart, runId, options.traceDirectory, [projection, ...extra]);
  return freeze({ version: 1, stack: graph.name, graph, runId, ok: recorded.snapshot.sharedState.ok === true,
    checks: recorded.snapshot.sharedState.checks as Record<string, ConnectionCheckResult>, events: projection.getEvents(), ...recorded });
}
