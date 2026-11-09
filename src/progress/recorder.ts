import { readProgressEvent } from './read-event.ts';
import { DEPLOYMENT_EVENT, type DeploymentEvent, type DeploymentRecorder, type DeploymentSnapshot } from './types.ts';

/** Use one recorder per active deployment. A fresh executor run resets its projection. */
export function createDeploymentRecorder(options: { id?: string } = {}): DeploymentRecorder {
  const id = options.id ?? 'iac-deployment-progress';
  if (typeof id !== 'string' || !id.trim()) throw new Error('A deployment recorder needs a nonempty ID');
  let runId: string | null = null;
  let sequence = 0;
  let ignoredEvents = 0;
  let subscriberFailures = 0;
  const resources = new Map<string, DeploymentEvent>();
  const events: DeploymentEvent[] = [];
  const listeners = new Set<(event: DeploymentEvent) => void>();
  const getSnapshot = (): DeploymentSnapshot => Object.freeze({
    version: 1, runId, sequence, resources: Object.freeze(Object.fromEntries(resources)),
    events: Object.freeze([...events]), ignoredEvents, subscriberFailures,
  });
  return {
    id,
    clear() {
      runId = null; sequence = 0; ignoredEvents = 0; subscriberFailures = 0;
      resources.clear(); events.length = 0;
    },
    onEmit(native) {
      if (native.name !== DEPLOYMENT_EVENT) return;
      const event = readProgressEvent(native, sequence + 1);
      if (!event || (runId !== null && event.runId !== runId)) { ignoredEvents++; return; }
      runId = event.runId; sequence = event.sequence;
      resources.set(event.resourceId, event); events.push(event);
      for (const listener of listeners) {
        try { listener(event); } catch { subscriberFailures++; }
      }
    },
    getSnapshot,
    getEvents(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Progress cursor must be a nonnegative safe integer');
      return Object.freeze(events.filter(event => event.sequence > afterSequence));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('A progress subscriber must be a function');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    toSnapshot() { return { name: 'IaC deployment progress', data: getSnapshot(), description: 'Observed reconciliation progress; ready follows provider confirmation.' }; },
  };
}
