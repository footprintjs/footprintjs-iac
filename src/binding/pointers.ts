import type { Json } from '../types.ts';

export function pointerParts(path: string): string[] | undefined {
  if (!path.startsWith('/') || path.length > 1024 || /~(?![01])|[\x00-\x1f\x7f]/.test(path)) return undefined;
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function pointerValue(value: Json | undefined, parts: readonly string[]): Json | undefined {
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part))) return undefined;
    value = (value as Record<string, Json>)[part];
  }
  return value;
}
