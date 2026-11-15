import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { HostAccessError } from './error.ts';

export interface PinnedAccessFile { path: string; realpath: string; dev: number; ino: number; digest: string; private: boolean }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function readPinnedAccessFile(path: string, privateFile: boolean, expected?: PinnedAccessFile): Promise<{ pin: PinnedAccessFile; bytes: Buffer }> {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || !/^[-A-Za-z0-9_./]+$/.test(path)) throw Error();
    const physical = await realpath(path), before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 1048576
      || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0) throw Error();
    const bytes = await readFile(path), after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || physical !== await realpath(path)) throw Error();
    const pin = { path, realpath: physical, dev: before.dev, ino: before.ino, digest: hash(bytes), private: privateFile };
    if (expected && (pin.realpath !== expected.realpath || pin.dev !== expected.dev || pin.ino !== expected.ino || pin.digest !== expected.digest)) { bytes.fill(0); throw Error(); }
    return { pin, bytes };
  } catch { throw new HostAccessError(expected ? 'host-trust-changed' : 'invalid-host-access'); }
}

/** A dedicated literal-host key file is a pin, rather than a broad SSH trust policy. */
export function validatePinnedKnownHosts(bytes: Buffer, hostname: string, port: number): void {
  try {
    const expected = port === 22 ? hostname : `[${hostname}]:${port}`;
    const lines = bytes.toString('utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (!lines.length || lines.length > 32) throw Error();
    for (const line of lines) {
      const fields = line.split(/\s+/);
      if (fields.length < 3 || fields[0] !== expected
        || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(fields[1]!)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2]!)) throw Error();
    }
  } catch { throw new HostAccessError('invalid-host-access'); }
}
