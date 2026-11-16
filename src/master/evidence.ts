import { loadEvidence } from '../evidence.ts';
import type { ApplyResult } from '../engine.ts';
import { canonical } from '../util.ts';
import { fingerprintPlan } from './plan.ts';
import type { SystemRevision } from './types.ts';

/** Bind promotion to native evidence, never merely to a callback's success flag. */
export async function verifyRevisionOutcome(revision: Pick<SystemRevision, 'graph'>, result: ApplyResult): Promise<void> {
  const evidence = await loadEvidence(result.evidencePath);
  if (!result.runId || evidence.runId !== result.runId || result.plan.stack !== revision.graph.name
    || evidence.stack !== revision.graph.name || evidence.graph?.digest !== revision.graph.digest
    || !evidence.structure || !evidence.deploymentChart || evidence.deploymentChart.runId !== result.runId
    || evidence.deploymentChart.graphDigest !== revision.graph.digest
    || evidence.chartStatus?.published !== true || evidence.chartStatus.failed !== 0
    || result.chartStatus?.published !== true || result.chartStatus.failed !== 0) throw Error('Native revision evidence does not match the candidate');
  // Read the plan through its strict data boundary even when a host supplied the ApplyResult.
  fingerprintPlan(result.plan);
  const native = evidence.snapshot.sharedState as Record<string, unknown>;
  const failure = native.failure;
  if ((result.ok && (result.failure !== null || native.failed !== false || failure !== null))
    || (!result.ok && (!result.failure || native.failed !== true || !failure))) throw Error('Native revision outcome disagrees with its result');
  if (result.tracePath !== undefined && (evidence.tracePath !== result.tracePath || !result.traceStatus
    || !evidence.traceStatus || result.traceStatus.failed !== 0 || result.traceStatus.flushed !== true
    || evidence.traceStatus.failed !== 0 || evidence.traceStatus.flushed !== true)) throw Error('Native revision trace capture is incomplete');
  for (const resource of revision.graph.resources) {
    const operations = result.plan.operations.filter(operation => operation.resource.id === resource.id);
    const operation = operations[0], actual = result.results[resource.id] as { status?: string } | undefined;
    const recordedResult = native[`result:${resource.id}`] as { status?: string; reason?: unknown } | undefined;
    // The engine's compact result omits the skipped branch's captured control reason.
    const matchingResult = actual?.status === 'skipped'
      ? canonical(actual) === canonical({ status: 'skipped' }) && recordedResult?.status === 'skipped'
        && canonical(recordedResult.reason ?? null) === canonical(failure)
      : canonical(recordedResult) === canonical(actual);
    const progress = native[`progress:${resource.id}`] as { runId?: string; resourceId?: string; status?: string; action?: string } | undefined;
    if (operations.length !== 1 || !operation || operation.resource.provider !== resource.provider
      || canonical(operation.resource.spec) !== canonical(resource.spec)
      || canonical(operation.resource.dependsOn ?? []) !== canonical(resource.dependsOn ?? [])
      || canonical(native[`desired:${resource.id}`]) !== canonical(resource.spec)
      || !matchingResult
      || !progress || progress.runId !== result.runId || progress.resourceId !== resource.id || progress.action !== operation.action
      || !['ready', 'failed', 'skipped'].includes(String(progress.status))
      || (result.ok && (progress.status !== 'ready' || actual?.status !== 'complete'))) throw Error('Native resource outcomes are incomplete or mismatched');
  }
}
