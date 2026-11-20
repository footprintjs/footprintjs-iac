import { readFile } from 'node:fs/promises';
import type { InfraGraph } from './graph/types.ts';
import { validateInfraGraph } from './graph/validation.ts';
import type { RuntimeSnapshot } from 'footprintjs';
import type { DeploymentChart } from './progress/chart.ts';
import { formatSlice, stateAt, type ControlDependency } from 'foottrace';
import { inspectRecordedDependencies } from './diagnostics/recorded-slice.ts';
import { recordedSchedule } from './diagnostics/recorded-schedule.ts';
export {verifyEvidenceTrace,type EvidenceTraceInput} from './evidence-trace.ts';

export interface RunEvidence {
  version: 1;
  runId: string;
  stack: string;
  snapshot: RuntimeSnapshot;
  controlDeps: Record<string, ControlDependency>;
  decisions: unknown;
  narrative: unknown;
  /** Native build-time chart shape for execution viewers. */
  structure?: unknown;
  deploymentChart?: DeploymentChart;
  chartStatus?: { published: boolean; failed: number };
  graph?: InfraGraph;
  tracePath?: string;
  traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
}

export async function loadEvidence(path: string): Promise<RunEvidence> {
  const evidence = JSON.parse(await readFile(path, 'utf8')) as RunEvidence;
  if (evidence.version !== 1 || !evidence.snapshot || !Array.isArray(evidence.snapshot.commitLog)
    || !evidence.controlDeps || typeof evidence.controlDeps !== 'object') throw new Error('Unsupported evidence snapshot');
  if (evidence.graph !== undefined) {
    evidence.graph = validateInfraGraph(evidence.graph);
    if (evidence.graph.name !== evidence.stack) throw new Error('Recorded graph belongs to another stack');
  }
  return evidence;
}

/** Read-only record replay: no adapter, workflow code, or external call is involved. */
export function replay(evidence: RunEvidence, commit?: number) {
  return stateAt(evidence.snapshot, commit ?? evidence.snapshot.commitLog.length - 1);
}

export function backwalk(evidence: RunEvidence, key = 'failure') {
  const { slice } = inspectRecordedDependencies(evidence, key);
  const text = formatSlice(slice), schedule = recordedSchedule(evidence, key);
  return schedule ? { slice, schedule, text: `${text}\n\nRecorded schedule for ${schedule.resourceId}\n${schedule.reasons.join('\n')}` } : { slice, text };
}
