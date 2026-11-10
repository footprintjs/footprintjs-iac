import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { Client, Filter, InvalidCredentialsError, type ClientOptions, type Entry, type SearchOptions, type SearchResult } from 'ldapts';
import { freeze, jsonCopy, keys, object } from '../graph/data.ts';
import { defineIdentitySource } from '../identity/source.ts';
import { readIdentitySubject } from '../identity/policy.ts';
import type { IdentityAuthentication, IdentityCredentials, IdentityObservationCode, IdentitySource, IdentitySourceAdapter } from '../identity/types.ts';

export interface LdapSourceOptions {
  readonly source: IdentitySource; readonly url: string;
  readonly usersDn: string; readonly groupsDn: string; readonly bindDn: string;
  readonly ca: string; readonly serverName?: string;
  readonly resolveBindPassword: () => Promise<string>;
}
/** Trusted transport seam for tests. Production uses ldapts with fresh, bounded TLS clients. */
export interface LdapClient {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: SearchOptions): Promise<SearchResult>;
  unbind(): Promise<void>;
}
export type LdapClientFactory = (options: ClientOptions) => LdapClient;

function exactDirectoryValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid LDAP directory configuration');
  return value;
}
function readOptions(input: LdapSourceOptions) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) throw new Error('Invalid LDAP source options');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) throw new Error('LDAP source options cannot contain accessors or hidden properties');
  const resolver = descriptors.resolveBindPassword?.value as unknown;
  if (typeof resolver !== 'function') throw new Error('LDAP source requires a bind-password resolver');
  const { resolveBindPassword: _resolver, ...data } = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  const row = object(jsonCopy(data), 'LDAP source options');
  keys(row, ['source', 'url', 'usersDn', 'groupsDn', 'bindDn', 'ca', 'serverName'], 'LDAP source options');
  const source = defineIdentitySource(row.source as unknown as IdentitySource);
  let url: URL;
  try { url = new URL(exactDirectoryValue(row.url)); } catch { throw new Error('LDAP source requires a credential-free LDAPS endpoint'); }
  if (url.protocol !== 'ldaps:' || !url.hostname || url.username || url.password || url.hash || url.search
    || !['', '/'].includes(url.pathname)) throw new Error('LDAP source requires a credential-free LDAPS endpoint');
  const ca = row.ca;
  if (typeof ca !== 'string' || ca.length > 64 * 1024 || ca.includes('\0')) throw new Error('Invalid LDAP trust certificate');
  try { new X509Certificate(ca); createSecureContext({ ca, minVersion: 'TLSv1.2' }); } catch { throw new Error('Invalid LDAP trust certificate'); }
  const serverName = row.serverName === undefined ? undefined : exactDirectoryValue(row.serverName);
  if (serverName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(serverName)) throw new Error('Invalid LDAP TLS server name');
  return { settings: freeze({ source, url: url.href.replace(/\/$/, ''), usersDn: exactDirectoryValue(row.usersDn),
    groupsDn: exactDirectoryValue(row.groupsDn), bindDn: exactDirectoryValue(row.bindDn), ca,
    ...(serverName === undefined ? {} : { serverName }) }), resolveBindPassword: resolver as () => Promise<string> };
}
function credentials(input: IdentityCredentials): IdentityCredentials | undefined {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) return undefined;
  const entries = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(entries).length !== 2 || !entries.username || !entries.password
    || Object.values(entries).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) return undefined;
  const username: unknown = entries.username.value, password: unknown = entries.password.value;
  if (typeof username !== 'string' || !username || username.length > 256 || username.trim() !== username || /[\x00-\x1f\x7f]/.test(username)
    || typeof password !== 'string' || password.length === 0 || password.length > 4096) return undefined;
  return { username, password };
}
function attribute(entry: Entry, key: string): string | undefined {
  const matching = Object.keys(entry).filter(name => name.toLowerCase() === key.toLowerCase());
  if (matching.length !== 1) return undefined;
  const value = entry[matching[0]!];
  return typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' ? value[0] : undefined;
}
function failureCode(error: unknown): IdentityObservationCode {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown : undefined;
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')
    || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'tls-error';
  if (typeof code === 'string' && ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)) return 'transport-failure';
  return 'backend-error';
}

/** LDAP authenticates and reads groups. It never grants application permissions or modifies directory entries. */
export class LdapSourceAdapter implements IdentitySourceAdapter<IdentityCredentials> {
  readonly id = 'ldap-source';
  private readonly settings: ReturnType<typeof readOptions>['settings'];
  private readonly resolveBindPassword: () => Promise<string>;
  private readonly clientFactory: LdapClientFactory;
  constructor(options: LdapSourceOptions, clientFactory: LdapClientFactory = options => new Client(options)) {
    const parsed = readOptions(options); this.settings = parsed.settings; this.resolveBindPassword = parsed.resolveBindPassword;
    if (typeof clientFactory !== 'function') throw new Error('Invalid LDAP client factory');
    this.clientFactory = clientFactory;
  }
  private client(): LdapClient {
    return this.clientFactory({ url: this.settings.url, timeout: 3000, connectTimeout: 3000, strictDN: true, autoRebind: false,
      tlsOptions: { ca: this.settings.ca, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        ...(this.settings.serverName === undefined ? {} : { servername: this.settings.serverName }) } });
  }
  async authenticate(input: IdentityCredentials): Promise<IdentityAuthentication> {
    const credential = credentials(input);
    if (!credential) return freeze({ status: 'rejected', code: 'invalid-credentials' });
    let directory: LdapClient | undefined, user: LdapClient | undefined;
    try {
      const bindPassword = await this.resolveBindPassword();
      // Empty passwords can invoke LDAP unauthenticated bind semantics, so they are never sent.
      if (typeof bindPassword !== 'string' || !bindPassword || bindPassword.length > 4096) return freeze({ status: 'unavailable', code: 'backend-error' });
      directory = this.client();
      await directory.bind(this.settings.bindDn, bindPassword);
      const found = await directory.search(this.settings.usersDn, { scope: 'sub', derefAliases: 'never',
        filter: `(&(objectClass=inetOrgPerson)(uid=${Filter.escape(credential.username)}))`,
        attributes: ['uid', 'entryUUID'], sizeLimit: 2, timeLimit: 3, paged: false });
      if (found.searchReferences.length || found.searchEntries.length > 1) return freeze({ status: 'unavailable', code: 'backend-error' });
      if (!found.searchEntries.length) return freeze({ status: 'rejected', code: 'invalid-credentials' });
      const entry = found.searchEntries[0]!;
      const uid = attribute(entry, 'uid'), uuid = attribute(entry, 'entryUUID');
      if (!uid || !uuid || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(uuid)
        || typeof entry.dn !== 'string' || !entry.dn || entry.dn.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.dn)) return freeze({ status: 'unavailable', code: 'backend-error' });
      user = this.client();
      try { await user.bind(entry.dn, credential.password); }
      catch (error) {
        // A service bind failure, search failure or transport error is never invalid user credentials.
        if (error instanceof InvalidCredentialsError) return freeze({ status: 'rejected', code: 'invalid-credentials' });
        throw error;
      }
      const memberships = await directory.search(this.settings.groupsDn, { scope: 'sub', derefAliases: 'never',
        filter: `(&(objectClass=groupOfNames)(member=${Filter.escape(entry.dn)}))`,
        attributes: ['cn'], sizeLimit: 256, timeLimit: 3, paged: false });
      if (memberships.searchReferences.length || memberships.searchEntries.length > 256) return freeze({ status: 'unavailable', code: 'backend-error' });
      const groups = memberships.searchEntries.map(group => attribute(group, 'cn'));
      if (groups.some(group => group === undefined)) return freeze({ status: 'unavailable', code: 'backend-error' });
      const subject = readIdentitySubject({ id: uuid.toLowerCase(), source: this.settings.source.id, groups: [...new Set(groups as string[])].sort() });
      return freeze({ status: 'authenticated', subject });
    } catch (error) { return freeze({ status: 'unavailable', code: failureCode(error) }); }
    finally {
      // Dispose both connections even when the other client's close fails. Close errors never expose a secret.
      await Promise.allSettled([user, directory].map(client => Promise.resolve().then(() => client?.unbind())));
    }
  }
}
