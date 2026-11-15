import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ConnectionProfileError } from './error.ts';

const maxBytes = 1024 * 1024;
/** The host chooses this directory; browser requests never supply filesystem paths. */
export async function privateDirectory(input: string): Promise<string> {
  try {
    const path = resolve(input); await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw Error();
    return await realpath(path);
  } catch { throw new ConnectionProfileError('storage-unavailable'); }
}
export async function readPrivateFile(path: string): Promise<Buffer | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw Error();
      return await file.readFile();
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ConnectionProfileError('storage-unavailable');
  }
}
/** Durable, no-clobber publication. Immutable identifiers survive concurrent writers. */
export async function writePrivateImmutable(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > maxBytes || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new ConnectionProfileError('storage-unavailable');
  const temporary = join(directory, '.pending-' + randomUUID()), destination = join(directory, name);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConnectionProfileError('profile-conflict');
      throw error;
    }
    await rm(temporary);
    const folder = await open(directory, constants.O_RDONLY); try { await folder.sync(); } finally { await folder.close(); }
  } catch (error) {
    if (error instanceof ConnectionProfileError) throw error;
    throw new ConnectionProfileError('storage-unavailable');
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
