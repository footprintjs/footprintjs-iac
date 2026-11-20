import { array, freeze, identifier, keys, object } from '../graph/data.ts';
import type { Json } from '../types.ts';

export interface ScheduleReasons {
  readonly dependencies: readonly { readonly resourceId: string; readonly attributes: readonly string[] }[];
  readonly capacity?: { readonly fromBatch: number; readonly throughBatch: number; readonly limit: number };
  readonly batchBarrier?: number;
}

export function readScheduleReasons(input: Json, batchIndex: number): ScheduleReasons {
  const row = object(input, 'schedule reasons');
  keys(row, ['dependencies', 'capacity', 'batchBarrier'], 'schedule reasons');
  const dependencies = array(row.dependencies, 'scheduled dependencies').map(value => {
    const source = object(value, 'scheduled dependency');
    keys(source, ['resourceId', 'attributes'], 'scheduled dependency');
    return { resourceId: identifier(source.resourceId, 'scheduled resource'),
      attributes: array(source.attributes, 'scheduled provider attributes').map(item => identifier(item, 'scheduled attribute')) };
  });
  const capacity = row.capacity === undefined ? undefined : object(row.capacity, 'schedule capacity');
  const earlier = (index: unknown): index is number => Number.isSafeInteger(index) && (index as number) >= 0 && (index as number) < batchIndex;
  if (capacity) {
    keys(capacity, ['fromBatch', 'throughBatch', 'limit'], 'schedule capacity');
    if (!earlier(capacity.fromBatch) || capacity.throughBatch !== batchIndex - 1
      || !Number.isSafeInteger(capacity.limit) || (capacity.limit as number) < 1 || (capacity.limit as number) > 128) throw Error('Invalid capacity wait');
  }
  if (row.batchBarrier !== undefined && (!earlier(row.batchBarrier) || row.batchBarrier !== batchIndex - 1)) throw Error('Invalid batch barrier');
  return freeze({ dependencies, ...(capacity && { capacity: capacity as unknown as NonNullable<ScheduleReasons['capacity']> }),
    ...(row.batchBarrier !== undefined && { batchBarrier: row.batchBarrier as number }) });
}
