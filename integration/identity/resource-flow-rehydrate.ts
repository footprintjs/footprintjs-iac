import type { EmitEvent } from 'footprintjs';
import { createDeploymentRecorder } from '../../src/progress/recorder.ts';
import { DEPLOYMENT_EVENT, type DeploymentSnapshot } from '../../src/progress/types.ts';
import { createConnectionRecorder } from '../../src/connections/recorder.ts';
import { CONNECTION_EVENT, type ConnectionEvent, type ConnectionSnapshot } from '../../src/connections/types.ts';
import { createIdentityRecorder } from '../../src/identity/recorder.ts';
import { IDENTITY_EVENT, type IdentityEvent, type IdentitySnapshot } from '../../src/identity/types.ts';
import type { DeploymentChart } from '../../src/progress/chart.ts';
import type { DeploymentEvent } from '../../src/progress/types.ts';
import { canonical } from '../../src/util.ts';

function native(name: string, event: DeploymentEvent | ConnectionEvent | IdentityEvent): EmitEvent {
  const { timestamp, runtimeStageId, sequence: _sequence, ...payload } = event;
  return { name, timestamp, runtimeStageId, payload } as EmitEvent;
}
function admitEvents<T extends { runId: string; sequence: number }>(events: T[], runId: string, append: (event: T) => void, captured: () => readonly T[]): void {
  if (!Array.isArray(events) || events.length > 10000) throw Error('Invalid retained native events');
  events.forEach((event, index) => {
    if (event.runId !== runId || event.sequence !== index + 1) throw Error('Invalid retained native event identity');
    append(event);
    if (captured().length !== index + 1 || canonical(captured()[index]) !== canonical(event)) throw Error('Retained native event was not admitted by its recorder');
  });
}
export function restoreDeployment(chart: DeploymentChart, events: DeploymentEvent[]): DeploymentSnapshot {
  const recorder = createDeploymentRecorder(); recorder.onChart(chart);
  admitEvents(events, chart.runId, event => recorder.onEmit!(native(DEPLOYMENT_EVENT, event)), () => recorder.getEvents());
  if (recorder.getSnapshot().ignoredCharts || recorder.getSnapshot().ignoredEvents
    || events.some(event => !chart.resources.some(resource => resource.resourceId === event.resourceId && resource.action === event.action))) throw Error('Retained native deployment differs from its chart');
  return recorder.getSnapshot();
}
export function restoreConnections(runId: string, events: ConnectionEvent[]): ConnectionSnapshot {
  const recorder = createConnectionRecorder();
  admitEvents(events, runId, event => recorder.onEmit!(native(CONNECTION_EVENT, event)), () => recorder.getEvents());
  return recorder.getSnapshot();
}
export function restoreIdentity(runId: string, events: IdentityEvent[]): IdentitySnapshot {
  const recorder = createIdentityRecorder();
  admitEvents(events, runId, event => recorder.onEmit!(native(IDENTITY_EVENT, event)), () => recorder.getEvents());
  return recorder.getSnapshot();
}
