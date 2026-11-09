import { freeze, jsonCopy } from '../graph/data.ts';
import { errorMessage } from '../util.ts';
import { connectionErrorDetails, connectionErrorObservation, readConnectionObservation } from './data.ts';
import type { ConnectionStage, ConnectionScope } from './scope.ts';
import { CONNECTION_EVENT, type ConnectionAdapter, type ConnectionCheckRequest, type ConnectionCheckResult } from './types.ts';

function publish(scope: ConnectionScope, request: ConnectionCheckRequest, runId: string, status: 'checking' | 'connected' | 'failed', result?: ConnectionCheckResult): void {
  const payload = { version: 1, runId, connectionId: request.connectionId, from: request.from.id, to: request.to.id, status,
    ...(result?.observation ? { observation: result.observation } : {}), ...(result?.error ? { message: result.error } : {}),
    ...(result?.details ? { details: result.details } : {}) };
  scope.setValue(`progress:${request.connectionId}`, payload);
  scope.emitEvent(CONNECTION_EVENT, payload);
}

export function loadConnectionsStage(graphDigest: string, requests: readonly ConnectionCheckRequest[]): ConnectionStage {
  return scope => {
    scope.setValue('graphDigest', graphDigest); scope.setValue('probeFailed', false);
    scope.setValue('expectedConnectionIds', requests.map(request => request.connectionId));
    for (const request of requests) scope.setValue(`request:${request.connectionId}`, jsonCopy(request));
  };
}
export function checkingStage(id: string, runId: string): ConnectionStage {
  return scope => {
    void scope.getValue('graphDigest');
    const request = scope.getValue(`request:${id}`) as ConnectionCheckRequest;
    publish(scope, request, runId, 'checking');
  };
}
export function probeStage(id: string, adapter: ConnectionAdapter): ConnectionStage {
  return async scope => {
    const request = freeze(jsonCopy(scope.getValue(`request:${id}`)) as unknown as ConnectionCheckRequest);
    void scope.getValue(`progress:${id}`);
    const base = { connectionId: id, from: request.from.id, to: request.to.id };
    let result: ConnectionCheckResult;
    try {
      const observation = readConnectionObservation(await adapter.check(request));
      scope.setValue(`observation:${id}`, jsonCopy(observation));
      result = { ...base, status: 'connected', observation: scope.getValue(`observation:${id}`) as typeof observation };
    } catch (error) {
      const details = connectionErrorDetails(error);
      const observation = connectionErrorObservation(error);
      if (observation) scope.setValue(`observation:${id}`, jsonCopy(observation));
      const failure = { message: errorMessage(error), ...(details ? { details } : {}) };
      scope.setValue(`error:${id}`, failure);
      const captured = scope.getValue(`error:${id}`) as typeof failure;
      result = { ...base, status: 'failed', error: captured.message, ...(captured.details ? { details: captured.details } : {}),
        ...(observation ? { observation: scope.getValue(`observation:${id}`) as typeof observation } : {}) };
    }
    scope.setValue(`result:${id}`, jsonCopy(result));
    scope.setValue('probeFailed', result.status === 'failed');
  };
}
export function outcomeStage(id: string, runId: string, status: 'connected' | 'failed'): ConnectionStage {
  return scope => {
    const request = scope.getValue(`request:${id}`) as ConnectionCheckRequest;
    const result = scope.getValue(`result:${id}`) as ConnectionCheckResult;
    if (result.status !== status) throw new Error('Recorded connection decision differs from its observation');
    publish(scope, request, runId, status, result);
  };
}
export const summarizeConnectionsStage: ConnectionStage = scope => {
  const checks: Record<string, ConnectionCheckResult> = {};
  for (const id of scope.getValue('expectedConnectionIds') as string[]) checks[id] = scope.getValue(`result:${id}`) as ConnectionCheckResult;
  scope.setValue('checks', jsonCopy(checks));
  scope.setValue('ok', Object.values(checks).every(result => result.status === 'connected'));
};
