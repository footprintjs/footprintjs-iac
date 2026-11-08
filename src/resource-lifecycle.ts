import type { ResourceLifecycle } from './types.ts';

/** Read the small persisted lifecycle policy without ignoring unknown fields or invoking accessors. */
export function readResourceLifecycle(input: unknown): ResourceLifecycle | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('Invalid resource lifecycle: expected a plain object');
  }
  if (Object.getOwnPropertySymbols(input).length) throw new Error('Invalid resource lifecycle: symbol fields are unsupported');
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(fields)) {
    if (key !== 'retainOnRemoval') throw new Error(`Unknown resource lifecycle field: ${key}`);
    if (!('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'boolean') {
      throw new Error('Invalid resource lifecycle retainOnRemoval: expected a boolean data field');
    }
  }
  return fields.retainOnRemoval ? { retainOnRemoval: fields.retainOnRemoval.value as boolean } : {};
}

/** An absent flag cannot silently withdraw persisted deletion protection. */
export function resolveResourceLifecycle(desired: unknown, saved: unknown): ResourceLifecycle | undefined {
  const next = readResourceLifecycle(desired);
  const previous = readResourceLifecycle(saved);
  return next?.retainOnRemoval === undefined ? previous ?? next : next;
}
