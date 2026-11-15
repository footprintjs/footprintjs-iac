/** Adapter-declared connection inputs. These contracts contain no provider-specific branches. */
export interface ConnectionProfileField {
  name: string;
  label: string;
  kind: 'text' | 'url' | 'integer' | 'password';
  required?: boolean;
  secret?: boolean;
  description?: string;
}
export interface ConnectionAdapterSchema {
  id: string;
  label: string;
  description?: string;
  fields: readonly ConnectionProfileField[];
}
export interface ConnectionProfile {
  version: 1;
  id: string;
  label: string;
  adapterId: string;
  revision: number;
  previousId?: string;
  config: Readonly<Record<string, string>>;
  secretRefs: Readonly<Record<string, string>>;
  digest: string;
}
export interface ConnectionProfileRegistration {
  label: string;
  adapterId: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
}
export interface ConnectionProfileTestResult {
  profileId: string;
  ok: boolean;
  code?: 'connection-check-failed' | 'connection-check-unavailable';
}
/** Safe host surface for a dashboard. It deliberately cannot resolve secret values. */
export interface ConnectionProfileCatalog {
  schemas(): readonly ConnectionAdapterSchema[];
  list(): Promise<readonly ConnectionProfile[]>;
  register(input: ConnectionProfileRegistration): Promise<ConnectionProfile>;
  test(id: string): Promise<ConnectionProfileTestResult>;
}
export interface ConnectionProfileStore {
  list(): Promise<readonly ConnectionProfile[]>;
  get(id: string): Promise<ConnectionProfile | undefined>;
  /** Append only: never change an identifier's meaning. Atomically enforce CONNECTION_PROFILE_CAPACITY. */
  put(profile: ConnectionProfile): Promise<void>;
}
export interface SecretStoreAdapter {
  readonly id: string;
  /** Return a safe opaque reference, never the credential value or a URL containing credentials. */
  put(value: string): Promise<string>;
  get(reference: string): Promise<string | undefined>;
  delete(reference: string): Promise<void>;
}
export interface ResolvedConnectionProfile {
  profile: ConnectionProfile;
  secrets: Readonly<Record<string, string>>;
}
export interface ConnectionProfileAdapter {
  schema: ConnectionAdapterSchema;
  /** Trusted host code must admit the endpoint before any outbound I/O, then inspect read-only. */
  validate?(input: { config: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>> }): void | Promise<void>;
}
export interface ConnectionProfileRegistryOptions {
  adapters: readonly ConnectionProfileAdapter[];
  profiles: ConnectionProfileStore;
  secrets: SecretStoreAdapter;
}
