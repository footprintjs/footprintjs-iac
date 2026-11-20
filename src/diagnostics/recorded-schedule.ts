import type { RunEvidence } from '../evidence.ts';
import { canonical } from '../util.ts';
import { readDeploymentChart } from '../progress/chart.ts';

export function recordedSchedule(evidence: RunEvidence, key: string) {
  const resourceId = /^(?:progress|schedule|schedule-outcome):(.+)$/.exec(key)?.[1];
  if (!resourceId || evidence.deploymentChart === undefined) return;
  try {
    const chart = readDeploymentChart(evidence.deploymentChart);
    if (chart.runId !== evidence.runId || chart.stack !== evidence.stack) return;
    const binding = chart.resources.find(row => row.resourceId === resourceId);
    const decision = binding?.schedule;
    const recorded = evidence.snapshot.sharedState[`schedule:${resourceId}`];
    if (!decision || recorded === undefined || canonical(decision) !== canonical(recorded)) return;
    const occupants = (index: number) => chart.resources.filter(row => row.batchIndex === index).map(row => row.resourceId);
    const reasons = decision.dependencies.map(({resourceId, attributes}) =>
      `Dependency: ${resourceId}${attributes.length ? ` (${attributes.join(', ')})` : ''}`);
    if (decision.capacity) for (let index = decision.capacity.fromBatch; index <= decision.capacity.throughBatch; index++) {
      reasons.push(`Capacity: batch ${index} had ${decision.capacity.limit} slots occupied by ${occupants(index).join(', ')}`);
    }
    if (decision.batchBarrier !== undefined) reasons.push(`Batch barrier: wait for batch ${decision.batchBarrier} to settle (${occupants(decision.batchBarrier).join(', ')})`);
    const outcome = evidence.snapshot.sharedState[`schedule-outcome:${resourceId}`] as { kind?: unknown; resourceId?: unknown } | undefined;
    const failureGate = outcome?.kind === 'failure-gate';
    if (failureGate) reasons.push(typeof outcome?.resourceId === 'string' ? `Failure gate: skipped after ${outcome.resourceId} failed` : 'Failure gate: skipped after a preceding step failed');
    return { resourceId, batch: binding.batchIndex, decision, failureGate, reasons: reasons.length ? reasons : ['No recorded scheduling wait'] };
  } catch { return; }
}
