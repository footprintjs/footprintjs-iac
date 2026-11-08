import { canonical } from '../util.ts';
import type { Capability } from '../system/types.ts';
import type { Json, JsonObject } from '../types.ts';
import type { SupportAssessment, SupportContext } from './types.ts';

const duration = (value: Json | undefined) => typeof value === 'string' && /^[1-9][0-9]*(ms|s|m|h|d)$/.test(value);
const bag = (value: Json | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value: Json | undefined, allowed: readonly string[], check: (key: string, value: Json) => boolean): boolean {
  return bag(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => allowed.includes(key) && check(key, item));
}
function reference(value: Json | undefined, kind: string): boolean {
  return bag(value) && value.kind === kind && typeof value.path === 'string' && Object.keys(value).every(key => ['kind', 'path'].includes(key));
}
function computedProperty(capability: Capability, key: string, value: Json, context: SupportContext): boolean {
  if (key === 'program') { context.artifact(value); return true; }
  if (key === 'replicas') return Number.isSafeInteger(value) && typeof value === 'number' && value >= 1 && value <= 16;
  if (key === 'networks') return Array.isArray(value) && value.every(item => reference(item, 'network'));
  if (key === 'stores') return Array.isArray(value) && value.every(item => bag(item)
    && Object.keys(item).every(key => ['ref', 'access'].includes(key)) && reference(item.ref, 'store')
    && ['read', 'write', 'readWrite'].includes(String(item.access)));
  if (key === 'runAs') {
    const principal = context.principal(value);
    // Identity naming is simulated; arbitrary permission/role declarations are not silently accepted.
    return Object.entries(principal.properties).every(([name, item]) => name === 'description' && typeof item === 'string');
  }
  if (key === 'schedule') return capability.kind === 'scheduled-task' && fields(value, ['every'], (_key, item) => duration(item));
  return false;
}
function storeProperty(key: string, value: Json): boolean {
  if (key === 'purpose') return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
  if (key === 'dataModel') return ['keyValue', 'relational', 'document', 'object', 'file', 'block'].includes(String(value));
  if (key === 'sharing') return value === 'local' || value === 'shared';
  if (key === 'durability') return value === 'ephemeral' || value === 'persistent';
  if (key === 'expiration') return fields(value, ['idle', 'absolute'], (_key, item) => duration(item));
  if (key === 'retention') return fields(value, ['onRemoval', 'period'], (name, item) => name === 'period' ? duration(item) : item === 'retain' || item === 'delete');
  if (key === 'replication') return fields(value, ['copies'], (_key, item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 1 && item <= 16);
  return false;
}
function networkProperty(key: string, value: Json, context: SupportContext): boolean {
  if (key === 'protocol') return ['http', 'https', 'tcp', 'udp'].includes(String(value));
  if (key === 'port') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
  if (key === 'target') return reference(value, 'service');
  return false;
}

export function simulationSupport(capability: Capability, context: SupportContext): SupportAssessment {
  const unsupportedRequirements: string[] = [];
  const requirements: SupportAssessment['requirements'] = [];
  for (const [property, requested] of Object.entries(capability.properties).sort(([a], [b]) => a.localeCompare(b))) {
    let supported = false;
    try {
      supported = capability.family === 'compute' ? computedProperty(capability, property, requested, context)
        : capability.family === 'storage' ? storeProperty(property, requested)
        : capability.kind === 'endpoint' ? networkProperty(property, requested, context) : false;
    } catch { supported = false; }
    if (!supported) unsupportedRequirements.push(property);
    else requirements.push({
      property, requested, status: 'simulated',
      reason: 'Declared ' + property + ' is modeled by the local simulator; no live service, durability, access or scheduling guarantee is established.',
    });
  }
  if (capability.family === 'compute' && !Object.hasOwn(capability.properties, 'program')) unsupportedRequirements.push('program');
  if (capability.kind === 'scheduled-task' && !Object.hasOwn(capability.properties, 'schedule')) unsupportedRequirements.push('schedule');
  if (capability.kind === 'endpoint') for (const property of ['protocol', 'port', 'target']) {
    if (!Object.hasOwn(capability.properties, property)) unsupportedRequirements.push(property);
  }
  return {
    supported: unsupportedRequirements.length === 0,
    reason: unsupportedRequirements.length ? 'The simulation adapter cannot model every declared requirement'
      : 'Configuration and dependency topology are simulated; no live workload, storage backend or authorization is provisioned',
    unsupportedRequirements, requirements,
  };
}
