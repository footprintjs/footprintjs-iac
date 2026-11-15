import { join } from 'node:path';
import { FileStateStore } from '../store.ts';
import { ConnectionProfileError } from './error.ts';
import { privateDirectory } from './private-files.ts';

const queues = new Map<string, Promise<void>>();
/** Same-process callers queue; the existing owned file lock excludes other local processes. */
export async function withFileProfileLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(directory, current);
  await previous;
  try {
    const locks = await privateDirectory(join(directory, '.locks'));
    return await new FileStateStore(locks).withLock('connection-profiles', work);
  } catch (error) {
    if (error instanceof ConnectionProfileError) throw error;
    throw new ConnectionProfileError('storage-unavailable');
  } finally {
    release(); if (queues.get(directory) === current) queues.delete(directory);
  }
}
