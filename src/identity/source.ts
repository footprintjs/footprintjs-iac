import { freeze, identifier, keys } from '../graph/data.ts';
import { plainRecord } from './values.ts';
import type { IdentitySource } from './types.ts';

export function defineIdentitySource(input: { readonly id: string; readonly kind: 'directory'; readonly ownership?: 'external' | 'managed' }): IdentitySource {
  const row = plainRecord(input, 'identity source'); keys(row, ['id', 'kind', 'ownership'], 'identity source');
  const id = identifier(row.id, 'identity source');
  if (row.kind !== 'directory') throw new Error('Unsupported identity source kind');
  if (row.ownership !== undefined && row.ownership !== 'external' && row.ownership !== 'managed') throw new Error('Invalid identity source ownership');
  return freeze({ id, kind: 'directory', ownership: row.ownership ?? 'external' });
}
