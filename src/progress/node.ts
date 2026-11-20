import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { validateInfraGraph } from '../graph/validation.ts';
import { readReviewedPlan } from '../master/plan.ts';
import { canonical, operationId } from '../util.ts';
import { freeze } from '../graph/data.ts';
import { readDeploymentChart } from './chart.ts';
import { executionBranch } from '../execution/batch-stages.ts';
import { progressAdmission as require } from './admission-data.ts';
import { nativeProgressWrites } from './admission-writes.ts';
import { admitProgressRecorder } from './admission-recorder.ts';
import type { DeploymentProgressAdmissionInput, AdmittedDeploymentProgress } from './admission-types.ts';
export type { DeploymentProgressAdmissionInput, AdmittedDeploymentEvent, AdmittedDeploymentProgress } from './admission-types.ts';
/** Reopen native deployment progress without running an engine, provider, workflow or probe. */
export async function admitDeploymentProgress(input: DeploymentProgressAdmissionInput): Promise<AdmittedDeploymentProgress> {
  const graph = validateInfraGraph(input.graph), plan = readReviewedPlan(input.plan), verified = await verifyEvidenceTrace(input.evidence);
  require(input.evidence.runId === input.runId && input.evidence.stack === graph.name && plan.stack === graph.name
    && input.evidence.graph?.digest === graph.digest && typeof input.ok === 'boolean');
  const desired = new Map(graph.resources.map(resource => [resource.id, resource]));
  const planned = new Map(plan.operations.map(operation => [operation.resource.id, operation]));
  require(graph.resources.every(resource => planned.has(resource.id)));
  for (const operation of plan.operations) {
    const { resource, action } = operation;
    const declared = desired.get(resource.id);
    // A prune is recorded against the new graph. Its extra operations must
    // match the captured native delete plan, rather than reenter desired state.
    require(declared ? action !== 'delete' && canonical(declared) === canonical(resource) : action === 'delete');
    require(operation.operationId === operationId(graph.name, resource, action === 'delete' ? 'delete' : 'apply')
      && input.evidence.snapshot.sharedState[`plan:${resource.id}`] === action
      && canonical(input.evidence.snapshot.sharedState[`desired:${resource.id}`]) === canonical(resource.spec));
  }
  const savedChart = input.evidence.deploymentChart === undefined ? undefined : readDeploymentChart(input.evidence.deploymentChart);
  const chart = input.chart === undefined ? savedChart : readDeploymentChart(input.chart);
  if (plan.operations.some(operation => operation.action === 'delete')) require(savedChart);
  if (savedChart) require(chart && canonical(chart) === canonical(savedChart));
  if (chart && input.evidence.chartStatus) require(input.evidence.chartStatus.published === true && input.evidence.chartStatus.failed === 0);
  if (chart) require(chart.runId === input.runId && chart.stack === graph.name && chart.graphDigest === graph.digest
    && canonical(chart.structure) === canonical(input.evidence.structure) && chart.resources.length === plan.operations.length
    && plan.operations.every(operation => chart.resources.some(row => row.resourceId === operation.resource.id && row.action === operation.action && row.executeStageId === executionBranch(operation.resource.id))));
  const admitted = { ...input, graph, plan }, source = nativeProgressWrites(admitted, chart, verified.runId);
  const events = input.recorder === undefined ? source.events : admitProgressRecorder(admitted, chart, source.writes);
  const resourceIds = [...desired.keys(), ...plan.operations.filter(operation => operation.action === 'delete').map(operation => operation.resource.id)];
  const resources = resourceIds.map(id => {
    const row = events.findLast(event => event.resourceId === id);
    require(row);
    return { ...row, id };
  });
  require(!input.ok || resources.every(resource => resource.status === (resource.action === 'delete' ? 'deleted' : 'ready')));
  return freeze({ events, resources, progressCapture: input.recorder === undefined
    ? { source: 'commit-fallback', observedStarts: false, warning: 'Historic recorder capture is absent; intra-stage starts and event timestamps are unobserved.' }
    : { source: 'native-recorder', observedStarts: true } });
}
