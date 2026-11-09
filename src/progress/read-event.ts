import type { EmitEvent } from 'footprintjs';
import type { Action } from '../types.ts';
import { DEPLOYMENT_EVENT, type DeploymentEvent, type DeploymentStatus } from './types.ts';

const statuses = new Set<DeploymentStatus>(['pending', 'deploying', 'ready', 'failed', 'skipped', 'deleted']);
const actions = new Set<Action>(['create', 'update', 'verify', 'delete', 'noop']);
const own = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;

/** Native payloads are ordinary JSON; manually supplied accessor payloads are refused. */
export function readProgressEvent(event: EmitEvent, sequence: number): DeploymentEvent | undefined {
  if (event.name !== DEPLOYMENT_EVENT) return undefined;
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(payload))) return undefined;
  if (Object.values(Object.getOwnPropertyDescriptors(payload)).some(descriptor => !('value' in descriptor))) return undefined;
  const runId = own(payload, 'runId');
  const resourceId = own(payload, 'resourceId');
  const status = own(payload, 'status');
  const action = own(payload, 'action');
  const message = own(payload, 'message');
  if (own(payload, 'version') !== 1 || typeof runId !== 'string' || runId.length === 0
    || typeof resourceId !== 'string' || resourceId.length === 0
    || !statuses.has(status as DeploymentStatus) || !actions.has(action as Action)
    || (message !== undefined && typeof message !== 'string')
    || !Number.isFinite(event.timestamp) || typeof event.runtimeStageId !== 'string') return undefined;
  return Object.freeze({
    version: 1, sequence, runId, resourceId, status: status as DeploymentStatus, action: action as Action,
    timestamp: event.timestamp, runtimeStageId: event.runtimeStageId,
    ...(message === undefined ? {} : { message }),
  });
}
