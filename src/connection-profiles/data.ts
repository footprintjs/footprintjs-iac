import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { ConnectionProfileError, type ConnectionProfileErrorCode } from './error.ts';
import type { ConnectionAdapterSchema, ConnectionProfile, ConnectionProfileRegistration } from './types.ts';

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw Error();
}
function short(input: unknown, max = 512): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) throw Error();
  return input;
}
function strings(input: unknown, max: number): Record<string, string> {
  const source = record(input), result: Record<string, string> = {};
  if (Object.keys(source).length > 64) throw Error();
  for (const [key, value] of Object.entries(source)) {
    identifier(key, 'connection field');
    if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) throw Error();
    result[key] = value;
  }
  return result;
}
function safe<T>(code: ConnectionProfileErrorCode, work: () => T): T {
  try { return work(); } catch { throw new ConnectionProfileError(code); }
}
export function readConnectionAdapterSchema(input: unknown): ConnectionAdapterSchema {
  return safe('invalid-schema', () => {
    const value = record(jsonCopy(input)); exact(value, ['id', 'label', 'description', 'fields']);
    identifier(value.id, 'adapter'); short(value.label);
    if (value.description !== undefined) short(value.description, 2048);
    if (!Array.isArray(value.fields) || !value.fields.length || value.fields.length > 64) throw Error();
    const names = new Set<string>();
    for (const item of value.fields) {
      const field = record(item); exact(field, ['name', 'label', 'kind', 'required', 'secret', 'description']);
      const name = identifier(field.name, 'connection field'); if (names.has(name)) throw Error(); names.add(name);
      short(field.label); if (!['text', 'url', 'integer', 'password'].includes(field.kind as string)) throw Error();
      for (const flag of ['required', 'secret']) if (field[flag] !== undefined && typeof field[flag] !== 'boolean') throw Error();
      if (field.kind === 'password' && field.secret !== true) throw Error();
      if (field.description !== undefined) short(field.description, 2048);
    }
    return freeze(value as unknown as ConnectionAdapterSchema);
  });
}
export function readConnectionProfileRegistration(input: unknown): ConnectionProfileRegistration {
  return safe('invalid-registration', () => {
    const value = record(jsonCopy(input)); exact(value, ['label', 'adapterId', 'config', 'secrets']);
    return { label: short(value.label, 160), adapterId: identifier(value.adapterId, 'adapter'), config: strings(value.config, 8192), secrets: strings(value.secrets, 65536) };
  });
}
export function validateConnectionFields(schema: ConnectionAdapterSchema, config: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>, references = false): void {
  safe('invalid-registration', () => {
    const known = new Set(schema.fields.map(field => field.name));
    for (const key of [...Object.keys(config), ...Object.keys(secrets)]) if (!known.has(key)) throw Error();
    for (const field of schema.fields) {
      const source = field.secret ? secrets : config, other = field.secret ? config : secrets;
      if (Object.hasOwn(other, field.name)) throw Error();
      const value = source[field.name];
      if (field.required && !value?.trim()) throw Error();
      if (value === undefined || !value.trim()) continue;
      if (field.secret && references) { short(value, 512); continue; }
      if (field.kind === 'integer' && (!/^-?(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw Error();
      if (field.kind === 'url') {
        const url = new URL(value);
        if (!url.hostname || ['file:', 'javascript:', 'data:'].includes(url.protocol)
          || url.username || url.password || url.hash || url.search) throw Error();
      }
    }
  });
}
export function connectionProfileDigest(profile: Omit<ConnectionProfile, 'digest'>): string { return fingerprint(profile); }
export function readConnectionProfile(input: unknown): ConnectionProfile {
  return safe('invalid-profile', () => {
    const value = record(jsonCopy(input)); exact(value, ['version', 'id', 'label', 'adapterId', 'revision', 'previousId', 'config', 'secretRefs', 'digest']);
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw Error();
    identifier(value.id, 'profile'); identifier(value.adapterId, 'adapter'); short(value.label, 160);
    if (value.previousId !== undefined) {
      identifier(value.previousId, 'previous profile'); if (value.previousId === value.id) throw Error();
    }
    if ((value.revision === 1) !== (value.previousId === undefined)) throw Error();
    const config = strings(value.config, 8192), secretRefs = strings(value.secretRefs, 512);
    for (const reference of Object.values(secretRefs)) short(reference, 512);
    const captured: Record<string, unknown> = { ...value, config, secretRefs };
    const { digest, ...rest } = captured;
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || fingerprint(rest) !== digest) throw Error();
    return freeze({ ...rest, digest } as unknown as ConnectionProfile);
  });
}
