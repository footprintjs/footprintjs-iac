import type { Json } from '../types.ts';
import { freeze, identifier, jsonCopy, keys, object } from '../graph/data.ts';
import type { ArtifactReference, Reference, ReferenceKind } from './types.ts';

export function scopeName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Capability group/leaf names must be simple identifiers without dots');
  return identifier(value, 'capability name');
}
export function capabilityPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid capability reference path');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('Capability references use group.leaf paths');
  parts.forEach(scopeName);
  return value;
}
export function readReference<K extends ReferenceKind>(input: unknown, expected?: K): Reference<K> {
  const row = object(jsonCopy(input), 'reference');
  keys(row, ['kind', 'path'], 'reference');
  if (!['store', 'network', 'service', 'principal'].includes(String(row.kind))
    || (expected !== undefined && row.kind !== expected)) throw new Error('Reference kind mismatch');
  const path = row.kind === 'principal' ? identifier(row.path, 'principal reference') : capabilityPath(row.path);
  return { kind: row.kind as K, path };
}
function reference<K extends ReferenceKind>(kind: K, path: string): Reference<K> {
  return freeze(readReference({ kind, path }, kind));
}
export const ref = freeze({
  store: (path: string) => reference('store', path),
  network: (path: string) => reference('network', path),
  service: (path: string) => reference('service', path),
  principal: (path: string) => reference('principal', path),
});
export function readArtifact(input: unknown): ArtifactReference {
  const row = object(jsonCopy(input), 'artifact reference');
  keys(row, ['kind', 'id'], 'artifact reference');
  if (row.kind !== 'artifact') throw new Error('Expected an artifact reference');
  return { kind: 'artifact', id: identifier(row.id, 'artifact id') };
}
/** An opaque program reference. Product bindings supply its actual artifact configuration. */
export function artifact(id: string): ArtifactReference { return freeze(readArtifact({ kind: 'artifact', id })); }
