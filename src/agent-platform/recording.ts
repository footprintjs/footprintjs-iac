import { dirname, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { canonical } from '../util.ts';
import { AGENT_BINDING_RECORDER_ID } from './create-agent-readiness-flow.ts';
import type { ResourceFlowState } from '../resource-flow/types.ts';
import type { AgentDeployment } from './types.ts';

/** Read-only native admission; no adapter, process or secret store is touched. */
export async function admitAgentReadinessRecording(definition: AgentDeployment, state: ResourceFlowState, directory: string): Promise<void> {
 for (const segment of state.segments) {
  if (dirname(resolve(segment.evidencePath)) !== directory || dirname(resolve(segment.tracePath)) !== directory) throw Error('Agent native recording left its bound directory');
  const info = await lstat(segment.evidencePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Agent native recording exceeds its file boundary');
  const evidence = await loadEvidence(segment.evidencePath); await verifyEvidenceTrace(evidence);
  const envelope = evidence as unknown as Record<string, unknown>;
  if (evidence.runId !== segment.runId || evidence.tracePath !== segment.tracePath || envelope.executionId !== state.executionId || envelope.status !== segment.status
   || envelope.configurationDigest !== undefined && envelope.configurationDigest !== definition.digest
   || evidence.stack !== definition.id || envelope.definitionDigest !== state.definitionDigest
   || canonical(envelope.definition) !== canonical({ id: definition.id, label: definition.label, resourceId: definition.environmentResourceId,
    mode: definition.mode, target: definition.target, configurationDigest: definition.digest })) throw Error('Agent native recording binding changed');
  const bindings = evidence.snapshot.recorders?.filter(recorder => recorder.id === AGENT_BINDING_RECORDER_ID);
  if (bindings?.length !== 1 || canonical(bindings[0]?.data) !== canonical({ definition })) throw Error('Agent revision differs from native recording');
  const progress = evidence.snapshot.recorders?.filter(recorder => recorder.id === 'iac-resource-flow-progress');
  const events = (progress?.[0]?.data as { events?: unknown[] } | undefined)?.events;
  if (progress?.length !== 1 || !Array.isArray(events) || events.length > state.events.length
   || canonical(events) !== canonical(state.events.slice(0, events.length))) throw Error('Agent lifecycle events differ from native recording');
  if (segment === state.segments.at(-1) && state.status !== 'running') {
   if (events.length !== state.events.length) throw Error('Agent lifecycle event history is incomplete');
   const shared = evidence.snapshot.sharedState;
   for (const key of ['resource', 'details', 'connection', 'verification'] as const) {
    if (canonical(shared[key]) !== canonical(state[key])) throw Error('Agent lifecycle ledger differs from native recording');
   }
  }
 }
 if (state.status === 'passed' && (!state.segments.length || state.segments.some(segment => segment.status !== 'passed' && segment.status !== 'paused')
  || state.segments.at(-1)?.status !== 'passed')) throw Error('Agent readiness has no complete native recording');
}
