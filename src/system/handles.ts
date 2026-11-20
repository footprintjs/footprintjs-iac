import { ref } from './references.ts';
import type { CapabilityReference, Reference, ReferenceKind } from './types.ts';

declare const handleType: unique symbol;
type CapabilityReferenceKind = CapabilityReference['kind'];
export type CapabilityHandle<K extends CapabilityReferenceKind = CapabilityReferenceKind> =
  Readonly<Reference<K>> & { readonly [handleType]: K };
export type StoreHandle = CapabilityHandle<'store'>;
export type ServiceHandle = CapabilityHandle<'service'>;
export type NetworkHandle = CapabilityHandle<'network'>;

const issued = new WeakSet<object>();
const designs = new WeakMap<object, ReadonlySet<object>>();

export function issueHandle<K extends CapabilityReferenceKind>(
  handles: Set<object>, kind: K, path: string,
): CapabilityHandle<K> {
  const handle = ref[kind](path) as CapabilityHandle<K>;
  issued.add(handle);
  handles.add(handle);
  return handle;
}

export function checkHandle(handles: ReadonlySet<object> | undefined, value: Reference<ReferenceKind>, required = false): void {
  if (!issued.has(value)) {
    if (required) throw new Error('Expected a typed capability handle from this system');
  } else if (!handles?.has(value)) {
    throw new Error('Capability handle belongs to a different or discarded declaration');
  }
}

export function registerDesignHandles(design: object, handles: ReadonlySet<object>): void { designs.set(design, handles); }
export function designHandles(design: object): ReadonlySet<object> | undefined { return designs.get(design); }
