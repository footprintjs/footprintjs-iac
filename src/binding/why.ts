import type { RunEvidence } from '../evidence.ts';
import { freeze, jsonCopy } from '../graph/data.ts';
import type { InfraGraph } from '../graph/types.ts';
import { checkHandle, designHandles, type CapabilityHandle } from '../system/handles.ts';
import type { Json, JsonObject, PlannedOperation } from '../types.ts';
import { canonical, fingerprint } from '../util.ts';
import { pointerParts, pointerValue } from './pointers.ts';
import type { BindingResult, LoweredPropertyOrigin } from './types.ts';

export interface BindingExplanation {
  capabilityId: string;
  capabilityPath: string;
  property: string;
  requested: Json;
  source: { kind: 'declaration' } | { kind: 'default'; reason: string };
  ruleId: string;
  adapterId: string;
  targetId: string;
  mode: 'real' | 'simulation';
  adapterReason?: string;
  outputs: LoweredPropertyOrigin[];
}

type ExplanationSource = BindingResult | InfraGraph | Pick<RunEvidence, 'graph'>;
function propertyBag(value: Json | undefined): JsonObject | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
}

/** Trace a logical property through binding. A recorded graph describes intent at that run, not a live observation. */
export function why(source: ExplanationSource, capability: CapabilityHandle | string, property: string): BindingExplanation | undefined {
  const binding = 'kind' in source && source.kind === 'system-binding' ? source : undefined;
  const graph = 'resources' in source ? source : source.graph;
  if (!graph) return;
  if (typeof capability !== 'string') checkHandle(designHandles(source), capability, true);
  const key = typeof capability === 'string' ? capability : capability.path;
  const attributes = graph.boundaries.map(row => row.attributes)
    .filter(row => row?.origin === 'capability');
  const origin = attributes.find(row => row!.capabilityPath === key) ?? attributes.find(row => row!.capabilityId === key);
  if (!origin) return;
  const { capabilityId, capabilityPath, mode, adapterId, ruleId, targetId } = origin;
  if (typeof capabilityId !== 'string' || typeof capabilityPath !== 'string' || typeof adapterId !== 'string'
    || typeof ruleId !== 'string' || typeof targetId !== 'string' || (mode !== 'real' && mode !== 'simulation')) return;
  const properties = propertyBag(origin.declaredProperties);
  if (!properties || !Object.hasOwn(properties, property)) return;
  const requested = jsonCopy(properties[property]);
  const defaultReason = propertyBag(origin.defaults)?.[property];
  const adapterReason = binding?.decisions.find(row => row.capabilityId === capabilityId)
    ?.requirements.find(row => row.property === property)?.reason ?? propertyBag(origin.propertyReasons)?.[property];
  const outputs = (Array.isArray(origin.propertyOrigins) ? origin.propertyOrigins : []).flatMap(item => {
    const row = propertyBag(item);
    if (row?.property === property && typeof row.resourceId === 'string' && typeof row.path === 'string') {
      return [{ property, resourceId: row.resourceId, path: row.path }];
    }
    return [];
  });
  return freeze({
    capabilityId, capabilityPath, property, requested, ruleId, adapterId, targetId, mode, outputs,
    source: typeof defaultReason === 'string' ? { kind: 'default', reason: defaultReason } : { kind: 'declaration' },
    ...(typeof adapterReason === 'string' && { adapterReason }),
  });
}

export interface PlanFieldExplanation {
  path: string;
  before?: Json;
  after?: Json;
  intentBefore?: BindingExplanation;
  intentAfter?: BindingExplanation;
}

/** Report only changed fields explicitly mapped by an adapter. Unmapped changes retain their normal plan evidence. */
export function whyPlanOperation(
  previous: InfraGraph | undefined, candidate: InfraGraph, operation: PlannedOperation,
): PlanFieldExplanation[] {
  if (operation.action === 'noop' || operation.action === 'verify' || operation.action === 'delete') return [];
  if (previous && previous.name !== candidate.name) return [];
  const id = operation.resource.id;
  const beforeSpec = previous?.resources.find(row => row.id === id)?.spec;
  const afterSpec = candidate.resources.find(row => row.id === id)?.spec;
  if (!afterSpec || fingerprint(afterSpec) !== fingerprint(operation.resource.spec)) return [];
  const before = mappedFields(previous, id), after = mappedFields(candidate, id);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.flatMap(key => {
    const intentBefore = before.get(key)?.intent, intentAfter = after.get(key)?.intent;
    const path = (after.get(key) ?? before.get(key))!.path;
    const parts = pointerParts(path);
    if (!parts) return [];
    const old = pointerValue(beforeSpec, parts), next = pointerValue(afterSpec, parts);
    if (old === next || (old !== undefined && next !== undefined && canonical(old) === canonical(next))) return [];
    return [{ path, ...(old !== undefined && { before: old }), ...(next !== undefined && { after: next }),
      ...(intentBefore && { intentBefore }), ...(intentAfter && { intentAfter }) }];
  });
}

function mappedFields(graph: InfraGraph | undefined, id: string) {
  const fields = new Map<string, { path: string; intent: BindingExplanation }>();
  if (!graph) return fields;
  const groups = new Set(graph.memberships.filter(row => row.resourceId === id).map(row => row.boundaryId));
  for (const boundary of graph.boundaries) {
    const attributes = boundary.attributes;
    if (!groups.has(boundary.id) || attributes?.origin !== 'capability' || typeof attributes.capabilityPath !== 'string'
      || !Array.isArray(attributes.propertyOrigins)) continue;
    const properties = new Set(attributes.propertyOrigins.flatMap(value => {
      const row = propertyBag(value);
      return row?.resourceId === id && typeof row.property === 'string' ? [row.property] : [];
    }));
    for (const property of properties) {
      const intent = why(graph, attributes.capabilityPath, property);
      for (const row of intent?.outputs ?? []) if (row.resourceId === id) {
        fields.set(JSON.stringify([attributes.capabilityPath, property, row.path]), { path: row.path, intent: intent! });
      }
    }
  }
  return fields;
}
