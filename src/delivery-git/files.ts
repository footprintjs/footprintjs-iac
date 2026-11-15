import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint } from '../util.ts';
import type { DeliveryContext } from '../delivery/types.ts';

export async function gitWorkspace(directory: string, context: DeliveryContext) {
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(directory));
  const id = fingerprint({ executionId: context.executionId, definitionDigest: context.definitionDigest, target: context.target });
  const path = join(root, id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw Error('Git workspace is not a private delivery directory');
  return { path, repository: join(path, 'repository.git'), checkout: join(path, 'checkout'), receipt: join(path, 'source.json') };
}
export async function exists(path: string): Promise<boolean> {
  try { const info = await lstat(path); if (info.isSymbolicLink()) throw Error('Git delivery paths must not be symbolic links'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function readGitReceipt(path: string): Promise<unknown | undefined> {
  if (!(await exists(path))) return;
  const info = await lstat(path); if (!info.isFile() || info.size > 8192) throw Error('Invalid Git source receipt');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function saveGitReceipt(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
