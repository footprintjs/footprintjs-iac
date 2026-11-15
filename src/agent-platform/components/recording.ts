import { dirname, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { loadEvidence } from '../../evidence.ts';
import { verifyEvidenceTrace } from '../../evidence-trace.ts';
import { canonical } from '../../util.ts';
import { COMPONENT_BINDING_RECORDER, componentBinding, componentReference } from './child.ts';
import type { AgentComponentGraph, AgentComponentState } from './types.ts';
import type { StoredAgentComponents } from './store.ts';

export const COMPONENT_GRAPH_RECORDER = 'iac-agent-component-graph';
/** Complete native coordinator + child references, admitted without invoking adapters. */
export async function admitAgentComponentsRecording(definition: AgentComponentGraph, ledger: StoredAgentComponents, input: readonly AgentComponentState[], directory: string): Promise<AgentComponentState[]> {
 const components = input.map(value => structuredClone(value));
 for (const value of components) for (const segment of value.readiness?.flow.segments ?? []) {
  const evidence = await loadEvidence(segment.evidencePath), component = definition.components.find(item => item.id === value.id)!;
  const binding = evidence.snapshot.recorders?.filter(value => value.id === COMPONENT_BINDING_RECORDER);
  if (binding?.length !== 1 || canonical(binding[0]?.data) !== canonical(componentBinding(definition, component))) throw Error('Native component graph association differs');
 }
 for (const [index, segment] of ledger.segments.entries()) {
  if (dirname(resolve(segment.evidencePath)) !== directory || dirname(resolve(segment.tracePath)) !== directory) throw Error('Native component coordinator left its directory');
  if (segment.status === 'incomplete') {
   if (index !== ledger.segments.length - 1 || ledger.status !== 'incomplete') throw Error('Uncertain component capture cannot precede another execution');
   continue;
  }
  const info = await lstat(segment.evidencePath); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Native component coordinator file exceeds limits');
  const evidence = await loadEvidence(segment.evidencePath); await verifyEvidenceTrace(evidence);
  const value = evidence as unknown as Record<string, unknown>, bindings = evidence.snapshot.recorders?.filter(value => value.id === COMPONENT_GRAPH_RECORDER);
  if (evidence.runId !== segment.runId || evidence.stack !== definition.id || evidence.tracePath !== segment.tracePath || value.status !== segment.status
   || value.executionId !== ledger.executionId || value.definitionDigest !== definition.digest || bindings?.length !== 1 || canonical(bindings[0]?.data) !== canonical({ definition, resumedFromRunId: index ? ledger.segments[index - 1]!.runId : null })
   || evidence.snapshot.sharedState.definitionDigest !== definition.digest || evidence.snapshot.sharedState.executionId !== ledger.executionId
   || evidence.snapshot.sharedState.resumedFromRunId !== (index ? ledger.segments[index - 1]!.runId : null)) throw Error('Native component coordinator binding differs');
  if (index === 0 && segment.resumedFromRunId !== undefined) throw Error('First component segment cannot resume another run');
  if (index > 0 && segment.resumedFromRunId !== ledger.segments[index - 1]?.runId) throw Error('Component coordinator resume link differs');
  if (index === ledger.segments.length - 1 && ledger.status !== 'running' && segment.status === 'passed') {
   if (evidence.snapshot.sharedState.outcome !== ledger.status) throw Error('Component outcome differs from native coordinator');
   for (const component of components) {
    const recorded = evidence.snapshot.sharedState['component:' + component.id] as { id?: string; status?: string } | undefined;
    if (component.status === 'pending' && (recorded?.status === 'skipped' || recorded?.status === 'incomplete')) component.status = recorded.status;
    if (canonical(recorded) !== canonical(componentReference(component))) throw Error('Native component child reference differs');
   }
  }
 }
 if (ledger.status !== 'running' && ledger.status !== 'incomplete' && (!ledger.segments.length || ledger.segments.at(-1)?.status !== 'passed')) throw Error('Component readiness lacks a complete native coordinator');
 return components;
}
