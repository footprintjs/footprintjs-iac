import type { ConnectionSnapshot, ConnectionEvent } from '../../src/connections/types.ts';
import type { IdentitySnapshot } from '../../src/identity/types.ts';
import { readDeploymentChart } from '../../src/progress/chart.ts';
import type { DeploymentSnapshot } from '../../src/progress/types.ts';

/** Public observations omit arbitrary provider messages, bodies and diagnostic objects. */
export function publicDeployment(snapshot: DeploymentSnapshot): DeploymentSnapshot {
  const events = snapshot.events.map(({ version, sequence, runId, resourceId, status, action, timestamp, runtimeStageId }) =>
    ({ version, sequence, runId, resourceId, status, action, timestamp, runtimeStageId }));
  return { version: 1, runId: snapshot.runId, sequence: snapshot.sequence,
    resources: Object.fromEntries(events.map(event => [event.resourceId, event])), events,
    ...(snapshot.chart ? { chart: readDeploymentChart(snapshot.chart) } : {}),
    ignoredCharts: snapshot.ignoredCharts, ignoredEvents: snapshot.ignoredEvents, subscriberFailures: snapshot.subscriberFailures };
}
function publicConnectionEvent(event: ConnectionEvent): ConnectionEvent {
  const { version, sequence, runId, connectionId, from, to, status, timestamp, runtimeStageId } = event;
  const observation = event.observation;
  return { version, sequence, runId, connectionId, from, to, status, timestamp, runtimeStageId,
    ...(observation ? { observation: { method: ['neo-identity-connection', 'oidc-ldaps-federation', 'kubernetes-pod-jwks-http', 'kubernetes-service-http'].includes(observation.method) ? observation.method : 'configured-adapter', target: publicEndpoint(observation.target),
      observedAt: observation.observedAt, latencyMs: observation.latencyMs, details: {} } } : {}) };
}
function publicEndpoint(value: string): string {
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash) return 'private endpoint'; }
  catch { return 'configured target'; }
  return value;
}
export function publicConnections(snapshot: ConnectionSnapshot): ConnectionSnapshot {
  const events = snapshot.events.map(publicConnectionEvent);
  return { version: 1, runId: snapshot.runId, sequence: snapshot.sequence, events,
    connections: Object.fromEntries(events.map(event => [event.connectionId, event])),
    ignoredEvents: snapshot.ignoredEvents, subscriberFailures: snapshot.subscriberFailures };
}
export function publicIdentity(snapshot: IdentitySnapshot): IdentitySnapshot {
  const events = snapshot.events.map(event => {
    const { version, sequence, runId, checkId, label, kind, expected, status, timestamp, runtimeStageId } = event;
    const observed = event.observation;
    return { version, sequence, runId, checkId, label, kind, expected, status, timestamp, runtimeStageId,
      ...(observed ? { observation: { verdict: observed.verdict, observedAt: observed.observedAt, latencyMs: observed.latencyMs } } : {}) };
  });
  return { version: 1, runId: snapshot.runId, sequence: snapshot.sequence, events,
    checks: Object.fromEntries(events.map(event => [event.checkId, event])),
    ignoredEvents: snapshot.ignoredEvents, subscriberFailures: snapshot.subscriberFailures };
}
