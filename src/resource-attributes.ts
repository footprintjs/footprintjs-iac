import { identifier, jsonCopy, keys, object } from './graph/data.ts';
import type { Json, JsonObject, Resource } from './types.ts';

const marker = '$resourceAttribute';
interface AttributeReference { resourceId: string; attribute: string }

/** Refer to one non-secret attribute of a direct deployment prerequisite. */
export function resourceAttribute(resourceId: string, attribute: string): JsonObject {
  return { [marker]: { resourceId: identifier(resourceId, 'output resource ID'), attribute: identifier(attribute, 'output attribute') } };
}

function attributeReference(value: JsonObject): AttributeReference | undefined {
  if (!Object.hasOwn(value, marker)) return;
  keys(value, [marker], 'resource attribute reference');
  const ref = object(value[marker]!, 'resource attribute reference');
  keys(ref, ['resourceId', 'attribute'], 'resource attribute reference');
  return { resourceId: identifier(ref.resourceId, 'output resource ID'), attribute: identifier(ref.attribute, 'output attribute') };
}

function mapReferences(input: Json, resolve: (ref: AttributeReference) => Json): Json {
  if (Array.isArray(input)) return input.map(value => mapReferences(value, resolve));
  if (!input || typeof input !== 'object') return input;
  const ref = attributeReference(input);
  if (ref) return resolve(ref);
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, mapReferences(value, resolve)]));
}

export function resourceAttributeSources(resource: Resource): Map<string, string[]> {
  const sources = new Map<string, Set<string>>();
  mapReferences(resource.spec, ({ resourceId, attribute }) => {
    const attributes = sources.get(resourceId) ?? new Set<string>();
    attributes.add(attribute);
    sources.set(resourceId, attributes);
    return null;
  });
  return new Map([...sources].map(([id, attributes]) => [id, [...attributes].sort()]));
}

export function hasResourceAttributes(resource: Resource): boolean {
  if (Object.hasOwn(resource.spec, marker)) throw Error('A resource attribute may replace a field but cannot replace the entire resource spec');
  const direct = new Set(resource.dependsOn ?? []);
  let found = false;
  mapReferences(resource.spec, ref => {
    if (!direct.has(ref.resourceId) || ref.resourceId === resource.id) {
      throw Error(`Resource ${resource.id} must depend directly on output resource ${ref.resourceId}`);
    }
    found = true;
    return null;
  });
  return found;
}

/** Undefined means a planned dependency operation must settle before this value can be known. */
export function resolveResourceAttributes(resource: Resource, lookup: (id: string) => JsonObject | undefined): JsonObject | undefined {
  let deferred = false;
  const spec = mapReferences(resource.spec, ({ resourceId, attribute }) => {
    const attributes = lookup(resourceId);
    if (attributes === undefined) { deferred = true; return null; }
    if (!Object.hasOwn(attributes, attribute)) throw Error(`Resource ${resourceId} did not publish attribute ${attribute} for ${resource.id}`);
    return jsonCopy(attributes[attribute]);
  });
  return deferred ? undefined : object(spec, 'resolved resource spec');
}

export function validateInputResolution(input: Json, action: unknown): void {
  const resolution = object(input, 'provider input resolution');
  keys(resolution, ['spec', 'deferred'], 'provider input resolution');
  if (resolution.deferred === true && resolution.spec === undefined && (action === 'create' || action === 'update')) return;
  if (resolution.deferred === undefined && resolution.spec !== undefined && action !== 'delete') {
    object(resolution.spec, 'resolved provider spec');
    return;
  }
  throw Error('Invalid provider input resolution');
}
