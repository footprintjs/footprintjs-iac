import { fingerprint } from '../util.ts';
import { freeze, jsonCopy, object } from '../graph/data.ts';
import { systemBody } from './shape.ts';
import type { SystemDesign } from './types.ts';

/** Reopen only a detached, validated plain-JSON design; no provider or binding is involved. */
export function validateSystemDesign(input: unknown): SystemDesign {
  const body = systemBody(input);
  const row = object(jsonCopy(input), 'system design');
  if (typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || fingerprint(body) !== row.digest) throw new Error('System design digest mismatch');
  return freeze({ ...body, digest: row.digest });
}
export const readSystemDesign = validateSystemDesign;
