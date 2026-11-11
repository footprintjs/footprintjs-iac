import { isIP } from 'node:net';
import { ConnectionCheckError } from '../../../src/connections/types.ts';
import type { JsonObject } from '../../../src/types.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,253}$/.test(value) ? value : null;

/** Failure evidence keeps routing and transport codes, never command messages or response bodies. */
export function publicServiceFailure(error: unknown): JsonObject {
  if (!(error instanceof ConnectionCheckError)) return {};
  return publicServiceDetails(error.details);
}

export function publicServiceDetails(value: unknown): JsonObject {
  const input = object(value), result: JsonObject = {};
  for (const side of ['before', 'after']) {
    const route = object(input[side]), safe: JsonObject = {};
    for (const key of ['serviceUID', 'deploymentUID']) safe[key] = text(route[key]);
    safe.servicePort = number(route.servicePort); safe.targetPort = number(route.targetPort) ?? text(route.targetPort);
    for (const key of ['clusterIPs', 'backendAddresses']) safe[key] = Array.isArray(route[key])
      ? route[key].filter((value): value is string => typeof value === 'string' && isIP(value) > 0).slice(0, 32) : [];
    safe.endpointPorts = Array.isArray(route.endpointPorts) ? route.endpointPorts.filter(value => number(value) !== null).slice(0, 32) : [];
    const pod = object(route.sourcePod); safe.sourcePod = { name: text(pod.name), uid: text(pod.uid), ip: typeof pod.ip === 'string' && isIP(pod.ip) ? pod.ip : null };
    safe.backendPods = Array.isArray(route.backendPods) ? route.backendPods.slice(0, 32).map(value => {
      const pod = object(value); return { name: text(pod.name), uid: text(pod.uid), ip: typeof pod.ip === 'string' && isIP(pod.ip) ? pod.ip : null };
    }) : [];
    if (Object.keys(route).length) result[side] = safe;
  }
  const probe = object(input.probe);
  if (Object.keys(probe).length) result.probe = {
    ok: probe.ok === true, stage: ['dns', 'http', 'response', 'complete', 'exec'].includes(String(probe.stage)) ? String(probe.stage) : 'unverified',
    observedAt: number(probe.observedAt), latencyMs: number(probe.latencyMs), httpStatus: number(probe.httpStatus),
    addresses: Array.isArray(probe.addresses) ? probe.addresses.filter((value): value is string => typeof value === 'string' && isIP(value) > 0).slice(0, 32) : [],
    transport: transportCodes(probe.transportError),
  };
  return result;
}

function transportCodes(input: unknown, depth = 0): JsonObject {
  if (depth > 3) return {};
  const error = object(input), result: JsonObject = {};
  if (typeof error.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code)) result.code = error.code;
  if (typeof error.address === 'string' && isIP(error.address)) result.address = error.address;
  if (typeof error.port === 'number' && Number.isInteger(error.port) && error.port > 0 && error.port <= 65535) result.port = error.port;
  if (error.cause) result.cause = transportCodes(error.cause, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.slice(0, 4).map(value => transportCodes(value, depth + 1));
  return result;
}
