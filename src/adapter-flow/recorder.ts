import { ADAPTER_FLOW_EVENT, type AdapterFlowEvent, type AdapterFlowProgress, type AdapterFlowRecorder, type NativeAdapterEmit } from './types.ts';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const phases = new Set(['inspect', 'revalidate', 'configure', 'reload', 'start', 'apply', 'observe']);
const statuses = new Set(['running', 'passed', 'failed', 'unknown']);
const keys = new Set(['version','deploymentRunId','adapterId','resourceId','operationId','componentId','phase','status','installed','running']);

/** Admission copies only bounded facts and stamps the native run/stage association. */
export function readAdapterFlowEvent(native: NativeAdapterEmit, sequence: number): AdapterFlowEvent | null {
  if (native.name !== ADAPTER_FLOW_EVENT || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  const raw = native.payload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(descriptors).some(key => !keys.has(key) || !('value' in descriptors[key]!))) return null;
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
  if (value.version !== 1 || !['deploymentRunId','adapterId','resourceId','operationId'].every(key => text(value[key]))
    || !phases.has(String(value.phase)) || !statuses.has(String(value.status))
    || value.componentId !== undefined && !text(value.componentId)
    || value.installed !== undefined && typeof value.installed !== 'boolean'
    || value.running !== undefined && typeof value.running !== 'boolean'
    || !text(native.sourcePosition?.runId) || !text(native.sourcePosition?.logRunId) || !text(native.runtimeStageId) || !text(native.stageName)
    || !Array.isArray(native.subflowPath) || native.subflowPath.length > 64 || native.subflowPath.some(path => !text(path))
    || !Array.isArray(native.sourcePosition?.drillPath) || native.sourcePosition.drillPath.length>64 || native.sourcePosition.drillPath.some(path=>!text(path))
    || !Number.isSafeInteger(native.sourcePosition.committedThroughIdx) || native.sourcePosition.committedThroughIdx < -1
    || !Number.isFinite(native.timestamp)) return null;
  return Object.freeze({ ...value as unknown as AdapterFlowProgress, runId: native.sourcePosition!.runId, logRunId:native.sourcePosition!.logRunId,
    committedThroughIdx:native.sourcePosition!.committedThroughIdx,
    drillPath:Object.freeze([...native.sourcePosition!.drillPath]),
    runtimeStageId: native.runtimeStageId, stageName: native.stageName, subflowPath: Object.freeze([...native.subflowPath]), timestamp: native.timestamp, sequence });
}

export function createAdapterFlowRecorder(options: { id?: string } = {}): AdapterFlowRecorder {
  const id = options.id ?? 'iac-adapter-progress';
  if (!text(id)) throw Error('Adapter recorder ID required');
  const events: AdapterFlowEvent[] = [], listeners = new Set<(event: AdapterFlowEvent) => void>();
  let ignoredEvents = 0, subscriberFailures = 0;
  const getSnapshot = () => ({ version: 1 as const, events: Object.freeze([...events]), ignoredEvents, subscriberFailures });
  return { id, clear() { events.length = 0; ignoredEvents = 0; subscriberFailures = 0; },
    onEmit(native) {
      if (native.name !== ADAPTER_FLOW_EVENT) return;
      const event = readAdapterFlowEvent(native, events.length + 1);
      if (!event) { ignoredEvents++; return; }
      events.push(event);
      for (const listener of listeners) try { listener(event); } catch { subscriberFailures++; }
    },
    getEvents(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw Error('Adapter progress cursor invalid');
      return Object.freeze(events.filter(event => event.sequence > afterSequence));
    },
    subscribe(listener) { if (typeof listener !== 'function') throw Error('Adapter progress listener required'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot, toSnapshot() { return { name: 'Native adapter progress', data: getSnapshot() }; },
  };
}
