import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Preserve the preparation format: concatenated bytes in this exact order. */
export const SEALED_IDENTITY_FILES = ['ldap/slapd.conf', 'ldap/seed.ldif', 'provider/neo-realm.json', 'provider/ldap.crt', 'provider.env'] as const;

async function ownedFile(directory: string, name: string): Promise<Buffer> {
  const path = resolve(directory, name), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || await realpath(path) !== path) throw Error();
  return readFile(path);
}

/** Resolve secrets only into transient provider memory, never into a resource declaration or diagnostic. */
export async function assertSealedIdentityFiles(directory: string, expectedDigest: string): Promise<Map<string, Buffer>> {
  try {
    const canonical = await realpath(directory), info = await lstat(directory);
    if (canonical !== directory || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw Error();
    const files = new Map<string, Buffer>(), hash = createHash('sha256');
    for (const name of SEALED_IDENTITY_FILES) { const bytes = await ownedFile(directory, name); files.set(name, bytes); hash.update(bytes); }
    if (hash.digest('hex') !== expectedDigest) throw Error();
    const certificate = files.get('provider/ldap.crt')!;
    if (!(await ownedFile(directory, 'ldap/ldap.crt')).equals(certificate)) throw Error();
    const key = await ownedFile(directory, 'ldap/ldap.key');
    if (!new X509Certificate(certificate).checkPrivateKey(createPrivateKey(key))) throw Error();
    for (const name of ['ldap/slapd.conf', 'ldap/seed.ldif', 'ldap/ldap.key', 'provider.env']) {
      if (((await lstat(resolve(directory, name))).mode & 0o077) !== 0) throw Error();
    }
    return files;
  } catch { throw new Error('Identity fixture inputs failed their sealed validation'); }
}

export function identitySecretEnvironment(files: ReadonlyMap<string, Buffer>): string[] {
  const text = files.get('provider.env')?.toString('utf8');
  const lines = text?.split(/\r?\n/).filter(Boolean);
  if (!lines || lines.length !== 1 || !/^LDAP_BIND_PASSWORD=[A-Za-z0-9_-]{32,256}$/.test(lines[0]!)) {
    throw new Error('Identity fixture secret reference is invalid');
  }
  return lines;
}
