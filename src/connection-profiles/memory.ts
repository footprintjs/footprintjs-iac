import { randomUUID } from 'node:crypto';
import { identifier } from '../graph/data.ts';
import { readConnectionProfile } from './data.ts';
import { ConnectionProfileError } from './error.ts';
import type { ConnectionProfile, ConnectionProfileStore, SecretStoreAdapter } from './types.ts';
import { CONNECTION_PROFILE_CAPACITY } from './limits.ts';

export class MemoryConnectionProfileStore implements ConnectionProfileStore {
  private readonly profiles = new Map<string, ConnectionProfile>();
  async list(): Promise<readonly ConnectionProfile[]> { return [...this.profiles.values()].map(readConnectionProfile); }
  async get(id: string): Promise<ConnectionProfile | undefined> {
    const value = this.profiles.get(id); return value ? readConnectionProfile(value) : undefined;
  }
  async put(input: ConnectionProfile): Promise<void> {
    const value = readConnectionProfile(input);
    if (this.profiles.has(value.id)) throw new ConnectionProfileError('profile-conflict');
    if (this.profiles.size >= CONNECTION_PROFILE_CAPACITY) throw new ConnectionProfileError('profile-capacity');
    this.profiles.set(value.id, value);
  }
}
export class MemorySecretStore implements SecretStoreAdapter {
  readonly id: string;
  readonly #values = new Map<string, string>();
  constructor(options: { id?: string } = {}) { this.id = identifier(options.id ?? 'memory', 'secret store'); }
  async put(value: string): Promise<string> {
    if (typeof value !== 'string' || value.length > 65536 || value.includes('\u0000')) throw new ConnectionProfileError('secret-unavailable');
    const reference = `secret:${this.id}:${randomUUID()}`; this.#values.set(reference, value); return reference;
  }
  async get(reference: string): Promise<string | undefined> { return this.#values.get(reference); }
  async delete(reference: string): Promise<void> { this.#values.delete(reference); }
}
