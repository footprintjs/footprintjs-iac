import type { CombinedRecorder } from 'footprintjs';
import type { DeploymentChart, DeploymentChartObserver, NativeDeploymentRecording } from '../progress/chart.ts';
import { publicNativeSnapshot } from './public-native-snapshot.ts';

export const INTERNAL_STAGE_RECORDER_ID = 'iac-native-stage-progress';
type Row = { sequence: number; type: 'start' | 'end' | 'decision' | 'executed' | 'error'; runtimeStageId: string; stageId: string; stageName: string; timestamp?: number; chosen?: string | string[]; stageType?: string };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);

/** Observe native boundaries only. A microtask coalesces publications, never execution or event ordering. */
export function liveRecording(chart: DeploymentChart, observers: readonly DeploymentChartObserver[], snapshot: () => unknown) {
  const subscribers = observers.filter(observer => observer.onRecording);
  if (!subscribers.length) return undefined;
  let runId = '', droppedEvents = 0, observerFailures = 0, queued = false, closed = false;
  const events: Row[] = [];
  const flush = () => {
    queued = false; if (closed || !runId) return;
    let recording: NativeDeploymentRecording;
    try { recording = { snapshot: publicNativeSnapshot(snapshot()), structure: chart.structure,
      provenance: { runId: chart.runId, stack: chart.stack, ...(chart.graphDigest ? { graphDigest: chart.graphDigest } : {}) } }; }
    catch { observerFailures++; return; }
    for (const subscriber of subscribers) try { subscriber.onRecording!(structuredClone(recording)); } catch { observerFailures++; }
  };
  const record = (type: Row['type'], event: any, flow = false) => {
    const native = flow ? event.traversalContext : event;
    if (!runId || !native || !text(native.runtimeStageId) || !text(native.stageId) || !text(native.stageName)
      || flow && native.runId !== runId) { droppedEvents++; return; }
    if (events.length >= 20000) { droppedEvents++; return; }
    const chosen = type === 'decision' ? event.evidence?.chosen ?? event.evidence?.selected : undefined;
    const branch = text(chosen) ? chosen : Array.isArray(chosen) && chosen.length <= 256 && chosen.every(text) ? [...chosen] : undefined;
    events.push({ sequence: events.length + 1, type, runtimeStageId: native.runtimeStageId, stageId: native.stageId, stageName: native.stageName,
      ...(Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}), ...(branch === undefined ? {} : { chosen: branch }),
      ...(text(event.stageType) ? { stageType: event.stageType } : {}) });
    if (!queued) { queued = true; queueMicrotask(flush); }
  };
  const recorder: CombinedRecorder = {
    id: INTERNAL_STAGE_RECORDER_ID,
    clear() { runId = ''; events.length = 0; droppedEvents = 0; observerFailures = 0; queued = false; closed = false; },
    onRunStart(event) { if (text(event.traversalContext?.runId)) runId = event.traversalContext.runId; },
    onStageStart(event) { record('start', event); }, onStageEnd(event) { record('end', event); },
    onStageExecuted(event) { record('executed', event, true); }, onDecision(event) { record('decision', event, true); },
    onSelected(event) { record('decision', event, true); },
    onError(event) { if ('traversalContext' in event) record('error', event, true); },
    toSnapshot() { return { name: 'Native deployment stage observations', data: { version: 1, runId, events: [...events], droppedEvents, observerFailures } }; },
  };
  return { recorder, flush, close() { closed = true; } };
}
