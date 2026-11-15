import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FlowChartExecutor, type FlowchartCheckpoint } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { fileSink } from 'footprintjs/sinks';
import { fingerprint } from '../util.ts';
import { createPlatformAssessmentChart } from './create-assessment-chart.ts';
import { createPlatformExecutionChart } from './create-execution-chart.ts';
import type { PlatformStages } from './stages.ts';
import type { PlatformRecording } from './types.ts';

/** Executes only native FootPrint charts. The durable store coordinates their retained segments. */
export async function runPlatformNative(config: PlatformStages, phase: 'assessment' | 'execution', checkpoint?: FlowchartCheckpoint, profileId?: string) {
  const state = config.state, store = config.store, identity = randomUUID();
  const evidencePath = join(store.directory, identity + '.json'), tracePath = join(store.directory, identity + '.jsonl');
  const chart = phase === 'assessment' ? createPlatformAssessmentChart(config) : createPlatformExecutionChart(config);
  const control = controlDepRecorder({ id: 'iac-platform-control' });
  let sink: ReturnType<typeof fileSink> | undefined, executor: FlowChartExecutor | undefined;
  let failed = false, captureFailed = false;
  try {
    sink = fileSink(tracePath);
    executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix', sink: { adapter: sink, onFailure: 'fail', flush: 'auto' } });
    executor.enableNarrative(); executor.attachCombinedRecorder(control);
    for (const recorder of config.options.recorders ?? []) executor.attachCombinedRecorder(recorder);
    if (checkpoint) await executor.resume(checkpoint, { profileId }); else await executor.run();
  } catch { failed = true; }
  finally { if (sink) try { await sink.close(); } catch { captureFailed = true; } }
  if (!executor) {
    state.status = 'incomplete'; state.errorCode = 'platform-native-start-failed';
    await store.save({ version: 1, state }); return;
  }
  const snapshot = executor.getSnapshot(), paused = executor.isPaused(), nextCheckpoint = executor.getCheckpoint();
  const controlDeps: Record<string, unknown> = {};
  for (const commit of snapshot.commitLog) if (commit.runtimeStageId) {
    const entry = control.asLookup()(commit.runtimeStageId); if (entry) controlDeps[commit.runtimeStageId] = entry;
  }
  captureFailed ||= (snapshot.sink?.failed ?? 0) > 0;
  const status: PlatformRecording['status'] = captureFailed ? 'incomplete' : failed ? 'failed' : paused ? 'paused' : 'passed';
  const recording: PlatformRecording = { phase, runId: snapshot.runId!, evidencePath, tracePath, complete: !captureFailed, status,
    ...(checkpoint?.pausedExecution?.runId ? { resumedFromRunId: checkpoint.pausedExecution.runId } : {}) };
  try {
    await store.writeJson(evidencePath, { version: 1, kind: 'platform-native-evidence', stack: config.options.definition.id, phase, bindingDigest: state.bindingDigest,
      executionId: state.executionId, runId: snapshot.runId, snapshot, structure: chart.buildTimeStructure,
      controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries(), tracePath,
      traceStatus: { entries: snapshot.sink?.entries ?? 0, failed: (snapshot.sink?.failed ?? 0) + (captureFailed ? 1 : 0), flushed: !captureFailed }, status });
  } catch { captureFailed = true; recording.complete = false; recording.status = 'incomplete'; }
  state.recordings.push(recording);
  if (captureFailed || state.actions.some(action => action.status === 'uncertain' || action.status === 'started') || state.publicationStatus === 'uncertain') {
    state.status = 'incomplete'; state.errorCode ??= 'platform-effect-or-capture-uncertain';
  } else if (failed) state.status = phase === 'assessment' && state.plan?.disposition === 'blocked' ? 'blocked' : 'failed';
  else if (paused && nextCheckpoint) {
    try {
      const profiles = (await config.profileIds()).map(id => ({ id, label: id }));
      state.pause = { token: randomBytes(32).toString('hex'), prompt: 'Register or choose a Kubernetes access profile', profiles }; state.status = 'paused';
    } catch {
      state.status = 'incomplete'; state.errorCode = 'platform-profile-catalog-unavailable'; delete state.pause;
    }
  } else state.status = phase === 'assessment' ? 'running' : 'passed';
  await store.save({ version: 1, state, ...(state.status === 'paused' && nextCheckpoint ? { checkpoint: nextCheckpoint, checkpointDigest: fingerprint(nextCheckpoint) } : {}) });
}
