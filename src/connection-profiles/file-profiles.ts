import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifier } from '../graph/data.ts';
import { readConnectionProfile } from './data.ts';
import { ConnectionProfileError } from './error.ts';
import { privateDirectory, readPrivateFile, writePrivateImmutable } from './private-files.ts';
import type { ConnectionProfile, ConnectionProfileStore } from './types.ts';
import { CONNECTION_PROFILE_CAPACITY } from './limits.ts';
import { withFileProfileLock } from './file-lock.ts';

/** A host-owned private append-only local profile registry. No secret values are written here. */
export class FileConnectionProfileStore implements ConnectionProfileStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async list(): Promise<readonly ConnectionProfile[]> {
    try {
      const directory = await privateDirectory(this.directory);
      const profiles: ConnectionProfile[] = [];
      for (const name of (await readdir(directory)).sort()) {
        if (name.startsWith('.pending-') || name === '.locks') continue;
        if (!name.endsWith('.json')) throw new ConnectionProfileError('invalid-profile');
        const profile = await this.get(name.slice(0, -5)); if (!profile) throw new ConnectionProfileError('invalid-profile');
        profiles.push(profile);
      }
      return profiles;
    } catch (error) {
      if (error instanceof ConnectionProfileError) throw error;
      throw new ConnectionProfileError('storage-unavailable');
    }
  }
  async get(id: string): Promise<ConnectionProfile | undefined> {
    this.checkId(id); const directory = await privateDirectory(this.directory);
    const bytes = await readPrivateFile(join(directory, id + '.json')); if (!bytes) return;
    try {
      const profile = readConnectionProfile(JSON.parse(bytes.toString('utf8')));
      if (profile.id !== id) throw Error(); return profile;
    } catch { throw new ConnectionProfileError('invalid-profile'); }
  }
  async put(input: ConnectionProfile): Promise<void> {
    const profile = readConnectionProfile(input), directory = await privateDirectory(this.directory);
    await withFileProfileLock(directory, async () => {
      if (await this.get(profile.id)) throw new ConnectionProfileError('profile-conflict');
      if ((await this.list()).length >= CONNECTION_PROFILE_CAPACITY) throw new ConnectionProfileError('profile-capacity');
      await writePrivateImmutable(directory, profile.id + '.json', Buffer.from(JSON.stringify(profile) + '\n'));
    });
  }
  private checkId(id: string) {
    try { identifier(id, 'connection profile'); } catch { throw new ConnectionProfileError('invalid-profile'); }
  }
}
