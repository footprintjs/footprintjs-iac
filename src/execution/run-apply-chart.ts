import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder, type FlowChart } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { fileSink, type FileSink } from 'footprintjs/sinks';
import { errorMessage } from '../util.ts';
import { chartObserver, type ChartPublication } from './chart-observer.ts';

export const INTERNAL_CONTROL_RECORDER_ID = 'iac-internal-control-dependencies';

/** Runtime capture is best-effort and independent of the operation journal's durability. */
export async function runApplyChart<TScope>(chart: FlowChart<void, TScope>, runId: string, traceDirectory?: string, recorders: readonly CombinedRecorder[] = [], publication?: ChartPublication) {
  const tracePath = traceDirectory ? join(traceDirectory, `${runId}.jsonl`) : undefined;
  let traceSink: FileSink | undefined;
  let traceError: string | undefined;
  let traceExtraFailures = 0;
  if (tracePath) {
    try { await mkdir(traceDirectory!, { recursive: true, mode: 0o700 }); traceSink = fileSink(tracePath); }
    catch (error) { traceExtraFailures++; traceError = `Runtime trace setup failed: ${errorMessage(error)}`; }
  }
  const executor = new FlowChartExecutor(chart, {
    readTracking: 'full', writeProvenance: 'reads-prefix',
    ...(traceSink ? { sink: { adapter: traceSink, onFailure: 'report' as const, flush: 'auto' as const } } : {}),
  });
  const control = controlDepRecorder({ id: INTERNAL_CONTROL_RECORDER_ID });
  executor.enableNarrative();
  executor.attachCombinedRecorder(control);
  const bridge = publication ? chartObserver(publication) : undefined;
  if (bridge) executor.attachCombinedRecorder(bridge.recorder);
  for (const recorder of recorders) executor.attachCombinedRecorder(recorder);
  try { await executor.run(); }
  finally {
    if (traceSink) {
      try { await traceSink.close(); }
      catch (error) { traceExtraFailures++; traceError = `Runtime trace close failed: ${errorMessage(error)}`; }
    }
  }
  const snapshot = executor.getSnapshot();
  const traceStatus = tracePath ? {
    entries: snapshot.sink?.entries ?? 0,
    failed: (snapshot.sink?.failed ?? 0) + traceExtraFailures,
    flushed: traceSink !== undefined && (snapshot.sink?.failed ?? 0) === 0 && traceExtraFailures === 0,
    ...((traceError ?? snapshot.sink?.lastError) ? { error: traceError ?? snapshot.sink?.lastError } : {}),
  } : undefined;
  const controlDeps: Record<string, unknown> = {};
  for (const commit of snapshot.commitLog) {
    if (!commit.runtimeStageId) continue;
    const dependency = control.asLookup()(commit.runtimeStageId);
    if (dependency) controlDeps[commit.runtimeStageId] = dependency;
  }
  return { snapshot, structure: chart.buildTimeStructure, controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries(),
    ...(publication && bridge ? { deploymentChart: publication.chart, chartStatus: { ...bridge.status } } : {}),
    ...(tracePath ? { tracePath, traceStatus } : {}) };
}
