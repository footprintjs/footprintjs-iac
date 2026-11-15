import { randomUUID } from 'node:crypto';
import { freeze, identifier } from '../graph/data.ts';
import { connectionProfileDigest, readConnectionAdapterSchema, readConnectionProfile, readConnectionProfileRegistration, validateConnectionFields } from './data.ts';
import { ConnectionProfileError } from './error.ts';
import { CONNECTION_PROFILE_CAPACITY } from './limits.ts';
import type { ConnectionAdapterSchema, ConnectionProfile, ConnectionProfileAdapter, ConnectionProfileCatalog,
  ConnectionProfileRegistration, ConnectionProfileRegistryOptions, ConnectionProfileTestResult, ResolvedConnectionProfile } from './types.ts';

/** Registration is separate from workflow execution. Execution stores an immutable profile ID. */
export class ConnectionProfileRegistry implements ConnectionProfileCatalog {
  private readonly adapters = new Map<string, ConnectionProfileAdapter>();
  private readonly options: ConnectionProfileRegistryOptions;
  constructor(options: ConnectionProfileRegistryOptions) {
    this.options = options;
    for (const adapter of options.adapters) {
      const schema = readConnectionAdapterSchema(adapter.schema);
      if (this.adapters.has(schema.id)) throw new ConnectionProfileError('invalid-schema');
      this.adapters.set(schema.id, { schema, validate: adapter.validate?.bind(adapter) });
    }
  }
  schemas(): readonly ConnectionAdapterSchema[] { return freeze([...this.adapters.values()].map(adapter => adapter.schema)); }
  async list(): Promise<readonly ConnectionProfile[]> {
    try {
      const profiles = (await this.options.profiles.list()).map(profile => this.admit(profile));
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new ConnectionProfileError('invalid-profile');
      return freeze(profiles);
    } catch (error) {
      if (error instanceof ConnectionProfileError) throw error;
      throw new ConnectionProfileError('storage-unavailable');
    }
  }
  async get(id: string): Promise<ConnectionProfile | undefined> {
    this.profileId(id);
    try {
      const profile = await this.options.profiles.get(id);
      if (profile && profile.id !== id) throw new ConnectionProfileError('invalid-profile');
      return profile ? this.admit(profile) : undefined;
    } catch (error) {
      if (error instanceof ConnectionProfileError) throw error;
      throw new ConnectionProfileError('storage-unavailable');
    }
  }
  register(input: ConnectionProfileRegistration): Promise<ConnectionProfile> { return this.save(input); }
  /** Revisions receive a new ID, leaving every previously selected revision immutable. */
  async revise(id: string, input: ConnectionProfileRegistration): Promise<ConnectionProfile> {
    const previous = await this.get(id); if (!previous) throw new ConnectionProfileError('profile-not-found');
    return this.save(input, previous);
  }
  async resolve(id: string): Promise<ResolvedConnectionProfile> {
    const profile = await this.get(id); if (!profile) throw new ConnectionProfileError('profile-not-found');
    const secrets: Record<string, string> = {};
    for (const [field, reference] of Object.entries(profile.secretRefs)) {
      let value: string | undefined;
      try { value = await this.options.secrets.get(reference); } catch { throw new ConnectionProfileError('secret-unavailable'); }
      if (value === undefined) throw new ConnectionProfileError('secret-unavailable');
      secrets[field] = value;
    }
    const adapter = this.adapter(profile.adapterId);
    validateConnectionFields(adapter.schema, profile.config, secrets);
    await this.validate(adapter, profile.config, secrets);
    return { profile, secrets: freeze(secrets) };
  }
  async test(id: string): Promise<ConnectionProfileTestResult> {
    this.profileId(id);
    try {
      const profile = await this.get(id); if (!profile) throw new ConnectionProfileError('profile-not-found');
      if (!this.adapter(profile.adapterId).validate) return { profileId: id, ok: false, code: 'connection-check-unavailable' };
      await this.resolve(id); return { profileId: id, ok: true };
    }
    catch { return { profileId: id, ok: false, code: 'connection-check-failed' }; }
  }
  private async save(input: ConnectionProfileRegistration, previous?: ConnectionProfile): Promise<ConnectionProfile> {
    const value = readConnectionProfileRegistration(input), adapter = this.adapter(value.adapterId);
    if (previous && previous.adapterId !== value.adapterId) throw new ConnectionProfileError('invalid-registration');
    validateConnectionFields(adapter.schema, value.config, value.secrets);
    if ((await this.list()).length >= CONNECTION_PROFILE_CAPACITY) throw new ConnectionProfileError('profile-capacity');
    await this.validate(adapter, value.config, value.secrets);
    const secretRefs: Record<string, string> = {};
    let profile: ConnectionProfile | undefined;
    try {
      for (const [name, secret] of Object.entries(value.secrets)) {
        if (secret.trim()) secretRefs[name] = await this.options.secrets.put(secret);
      }
      for (const reference of Object.values(secretRefs)) {
        if (Object.values(value.secrets).some(secret => secret && (reference === secret || (secret.length >= 8 && reference.includes(secret))))) {
          throw new ConnectionProfileError('secret-unavailable');
        }
        try {
          const url = new URL(reference); if (url.username || url.password) throw new ConnectionProfileError('secret-unavailable');
        } catch (error) { if (error instanceof ConnectionProfileError) throw error; }
      }
      const definition = { version: 1 as const, id: 'cp-' + randomUUID(), label: value.label, adapterId: value.adapterId,
        revision: previous ? previous.revision + 1 : 1, ...(previous ? { previousId: previous.id } : {}), config: value.config, secretRefs };
      profile = readConnectionProfile({ ...definition, digest: connectionProfileDigest(definition) });
      await this.options.profiles.put(profile); return profile;
    } catch (error) {
      let definitelyUnpublished = !profile;
      if (profile) {
        try {
          const published = await this.get(profile.id);
          if (published?.digest === profile.digest) return published;
          definitelyUnpublished = published === undefined;
        } catch { /* Preserve credentials when publication cannot be reconciled. */ }
      }
      if (definitelyUnpublished) for (const reference of Object.values(secretRefs)) {
        try { await this.options.secrets.delete(reference); } catch { /* Unreferenced entries may be reclaimed by the owning secret adapter. */ }
      }
      throw new ConnectionProfileError(error instanceof ConnectionProfileError && error.code === 'profile-capacity' ? 'profile-capacity' : 'storage-unavailable');
    }
  }
  private admit(input: ConnectionProfile): ConnectionProfile {
    const profile = readConnectionProfile(input), adapter = this.adapter(profile.adapterId);
    try { validateConnectionFields(adapter.schema, profile.config, profile.secretRefs, true); }
    catch { throw new ConnectionProfileError('invalid-profile'); }
    return profile;
  }
  private adapter(id: string): ConnectionProfileAdapter {
    const adapter = this.adapters.get(id); if (!adapter) throw new ConnectionProfileError('unsupported-adapter'); return adapter;
  }
  private profileId(id: string): void {
    try { identifier(id, 'profile'); } catch { throw new ConnectionProfileError('profile-not-found'); }
  }
  private async validate(adapter: ConnectionProfileAdapter, config: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>): Promise<void> {
    try { await adapter.validate?.({ config: freeze({ ...config }), secrets: freeze({ ...secrets }) }); }
    catch { throw new ConnectionProfileError('connection-check-failed'); }
  }
}
