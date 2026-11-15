import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifier } from '../graph/data.ts';
import { ConnectionProfileError } from './error.ts';
import { privateDirectory, readPrivateFile, writePrivateImmutable } from './private-files.ts';
import type { SecretStoreAdapter } from './types.ts';

export interface EncryptedFileSecretStoreOptions { directory: string; key: Uint8Array; id?: string }
/** AES-256-GCM local adapter. Supply the key from trusted host configuration or a key-management adapter. */
export class EncryptedFileSecretStore implements SecretStoreAdapter {
  readonly id: string;
  readonly directory: string;
  readonly #key: Buffer;
  constructor(options: EncryptedFileSecretStoreOptions) {
    this.id = identifier(options.id ?? 'local', 'secret store'); this.directory = resolve(options.directory);
    if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) throw new ConnectionProfileError('secret-unavailable');
    this.#key = Buffer.from(options.key);
  }
  async put(value: string): Promise<string> {
    if (typeof value !== 'string' || value.length > 65536 || value.includes('\u0000')) throw new ConnectionProfileError('secret-unavailable');
    const directory = await privateDirectory(this.directory), id = randomUUID(), reference = `secret:${this.id}:${id}`;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(reference));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope = { version: 1, reference, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
    await writePrivateImmutable(directory, id + '.json', Buffer.from(JSON.stringify(envelope) + '\n')); return reference;
  }
  async get(reference: string): Promise<string | undefined> {
    const id = this.readReference(reference), directory = await privateDirectory(this.directory);
    const bytes = await readPrivateFile(join(directory, id + '.json')); if (!bytes) return;
    try {
      const envelope = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (envelope.version !== 1 || envelope.reference !== reference
        || Object.keys(envelope).some(key => !['version', 'reference', 'iv', 'tag', 'ciphertext'].includes(key))) throw Error();
      const iv = this.base64(envelope.iv), tag = this.base64(envelope.tag), ciphertext = this.base64(envelope.ciphertext);
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 262144) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(Buffer.from(reference)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch { throw new ConnectionProfileError('secret-unavailable'); }
  }
  async delete(reference: string): Promise<void> {
    const id = this.readReference(reference), directory = await privateDirectory(this.directory);
    await rm(join(directory, id + '.json'), { force: true }).catch(() => { throw new ConnectionProfileError('storage-unavailable'); });
  }
  private readReference(reference: string): string {
    const prefix = `secret:${this.id}:`;
    if (typeof reference !== 'string' || !reference.startsWith(prefix)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reference.slice(prefix.length))) {
      throw new ConnectionProfileError('secret-unavailable');
    }
    return reference.slice(prefix.length);
  }
  private base64(input: unknown): Buffer {
    if (typeof input !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw Error();
    return Buffer.from(input, 'base64');
  }
}
/** Local-development key bootstrap. Production hosts can supply a managed key instead. */
export async function loadOrCreateSecretKey(directory: string): Promise<Uint8Array> {
  const path = await privateDirectory(directory), name = 'master.key';
  let bytes = await readPrivateFile(join(path, name));
  if (!bytes) {
    try { await writePrivateImmutable(path, name, randomBytes(32)); }
    catch (error) { if (!(error instanceof ConnectionProfileError) || error.code !== 'profile-conflict') throw error; }
    bytes = await readPrivateFile(join(path, name));
  }
  if (!bytes || bytes.length !== 32) throw new ConnectionProfileError('secret-unavailable');
  return new Uint8Array(bytes);
}
