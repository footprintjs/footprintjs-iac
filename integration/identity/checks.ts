import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LdapSourceAdapter } from '../../src/identity-ldap/index.ts';
import { defineIdentitySource, readIdentitySubject, type AccessCheckAdapter, type AccessObservation, type IdentityCheckRequest,
  type IdentityCredentials, type IdentitySourceAdapter, type IdentityObservationDetails, type IdentityVerdict } from '../../src/identity/index.ts';
import { IdentityResponseError, readIdentityJson } from './http.ts';
import type { IdentityTarget } from './target.ts';

export const neoIdentityChecks: readonly IdentityCheckRequest[] = Object.freeze([
  { id: 'directory-available', label: 'Verified LDAPS bind and directory groups', kind: 'directory', expected: 'available' },
  { id: 'login-alice', label: 'LDAP reader can sign in through OIDC', kind: 'login', expected: 'authenticated' },
  { id: 'login-wrong-password', label: 'Wrong password is rejected', kind: 'login', expected: 'rejected' },
  { id: 'anonymous-refused', label: 'Anonymous Neo request is refused', kind: 'access', expected: 'denied' },
  { id: 'reader-allowed', label: 'Reader can reach real Neo session API', kind: 'access', expected: 'allowed' },
  { id: 'guest-denied', label: 'Signed-in guest is denied by Neo policy', kind: 'access', expected: 'denied' },
  { id: 'tampered-token-refused', label: 'Forged token is refused', kind: 'access', expected: 'denied' },
]);

export interface NeoIdentityCredentials { readonly alice: string; readonly bob: string; readonly directoryAdmin: string }
/** Trusted transport/source seams for tests; none can be selected by a dashboard request. */
export interface NeoIdentityCheckOptions {
  readonly directory?: IdentitySourceAdapter<IdentityCredentials>;
  readonly readCredentials?: () => Promise<NeoIdentityCredentials>;
  readonly fetch?: typeof fetch;
}
function readCredentials(input: unknown): NeoIdentityCredentials {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('Invalid private identity credentials');
  const fields = Object.getOwnPropertyDescriptors(input), allowed = ['alice', 'bob', 'directoryAdmin'];
  if (Object.getOwnPropertySymbols(input).length || Object.keys(fields).length !== allowed.length
    || allowed.some(key => !fields[key] || !('value' in fields[key]!) || !fields[key]!.enumerable
      || typeof fields[key]!.value !== 'string' || !fields[key]!.value || fields[key]!.value.length > 4096)) throw new Error('Invalid private identity credentials');
  return Object.freeze({ alice: fields.alice!.value as string, bob: fields.bob!.value as string, directoryAdmin: fields.directoryAdmin!.value as string });
}
/** Live checks use private credential closures. Only measured allowlisted outcomes cross the chart boundary. */
export async function neoIdentityCheckAdapter(target: IdentityTarget, options: NeoIdentityCheckOptions = {}): Promise<AccessCheckAdapter> {
  const credentials = readCredentials(await (options.readCredentials ? options.readCredentials()
    : readFile(join(target.directory, 'credentials.json'), 'utf8').then(text => JSON.parse(text) as unknown)));
  const directory = options.directory ?? new LdapSourceAdapter({ source: defineIdentitySource({ id: 'neo-directory', kind: 'directory' }),
    url: `ldaps://127.0.0.1:${target.ldapPort}`, serverName: target.directoryName,
    ca: await readFile(join(target.directory, 'provider/ldap.crt'), 'utf8'),
    usersDn: 'ou=people,dc=footprint,dc=local', groupsDn: 'ou=groups,dc=footprint,dc=local',
    bindDn: 'cn=admin,dc=footprint,dc=local', resolveBindPassword: async () => credentials.directoryAdmin });
  const authenticate = directory.authenticate.bind(directory), requestFetch = options.fetch ?? fetch;
  const tokens = new Map<string, string>();
  let directoryAvailable: boolean | undefined;
  const base = `http://127.0.0.1:${target.neoPort}`;
  async function login(user: 'alice' | 'bob', wrong = false) {
    if (!wrong) tokens.delete(user);
    const response = await requestFetch(target.issuer + '/protocol/openid-connect/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'neo-checks', username: user,
        password: wrong ? 'intentionally-wrong-local-fixture-password' : credentials[user], scope: 'openid' }),
    });
    const body = await readIdentityJson(response, 64 * 1024);
    const valid = response.status === 200 && typeof body.access_token === 'string' && body.access_token.length > 0 && body.access_token.length < 16 * 1024;
    if (valid && !wrong) tokens.set(user, body.access_token as string);
    const invalidGrant = response.status === 400 && body.error === 'invalid_grant';
    return { status: response.status, ok: valid, invalidCredentials: directoryAvailable === true && invalidGrant,
      backendUnavailable: directoryAvailable === false && invalidGrant };
  }
  async function invoke(token?: string) {
    return requestFetch(base + '/invoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json', 'x-session-id': 'identity-acceptance-reader', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ op: 'session-list' }) });
  }
  return { id: 'neo-live-identity-checks', async check(request): Promise<AccessObservation> {
    const started = Date.now();
    const outcome = (verdict: IdentityVerdict, details: IdentityObservationDetails = {}): AccessObservation => ({ verdict, observedAt: Date.now(), latencyMs: Date.now() - started,
      details: { sourceId: 'neo-directory', ...details } });
    if (!neoIdentityChecks.some(check => check.id === request.id)) return outcome('unavailable', { code: 'backend-error' });
    try {
      if (request.id === 'directory-available') {
        tokens.clear(); directoryAvailable = false;
        const result = await authenticate({ username: 'alice', password: credentials.alice });
        if (result.status !== 'authenticated') return outcome('unavailable', { phase: 'directory', protocol: 'ldaps', code: result.code });
        let subject;
        try { subject = readIdentitySubject(result.subject); }
        catch { return outcome('unavailable', { phase: 'directory', protocol: 'ldaps', code: 'backend-error' }); }
        directoryAvailable = subject.source === 'neo-directory' && subject.groups.includes('neo-readers');
        return outcome(directoryAvailable ? 'available' : 'unavailable', {
          protocol: 'ldaps', phase: 'directory', subjectId: subject.id, code: directoryAvailable ? 'verified' : 'backend-error' });
      }
      if (request.id === 'login-alice' || request.id === 'login-wrong-password') {
        const result = await login('alice', request.id === 'login-wrong-password');
        return outcome(result.ok ? 'authenticated' : result.invalidCredentials ? 'rejected' : 'unavailable', {
          protocol: 'oidc', phase: 'authentication', httpStatus: result.status,
          code: result.ok ? 'verified' : result.invalidCredentials ? 'invalid-credentials' : result.backendUnavailable ? 'provider-unavailable' : 'identity-unavailable' });
      }
      if (request.id === 'anonymous-refused' || request.id === 'tampered-token-refused') {
        const response = await invoke(request.id === 'tampered-token-refused' ? 'invalid.forged.signature' : undefined);
        await response.body?.cancel();
        return outcome(response.status === 401 ? 'denied' : 'unavailable', { protocol: 'http', phase: 'authentication', httpStatus: response.status,
          code: response.status === 401 ? 'anonymous' : 'backend-error' });
      }
      if (request.id === 'guest-denied' && !tokens.has('bob')) await login('bob');
      const token = tokens.get(request.id === 'reader-allowed' ? 'alice' : 'bob');
      if (!token) return outcome('unavailable', { phase: 'authentication', code: 'identity-unavailable' });
      const response = await invoke(token);
      const body = await readIdentityJson(response, 256 * 1024);
      const verdict = response.status === 200 && Array.isArray(body.sessions) ? 'allowed' : response.status === 403 ? 'denied' : 'unavailable';
      return outcome(verdict, {
        protocol: 'http', phase: 'authorization', httpStatus: response.status, policyId: 'neo-local-access', action: 'neo:chat', resource: 'neo',
        code: verdict === 'allowed' ? 'access-allowed' : verdict === 'denied' ? 'access-denied' : 'backend-error' });
    } catch (error) {
      return error instanceof IdentityResponseError
        ? outcome('unavailable', { code: error.code === 'response-read-failed' ? 'transport-failure' : 'backend-error',
          phase: error.code === 'response-read-failed' ? 'transport' : request.kind === 'login' ? 'authentication' : 'authorization',
          ...(error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}) })
        : outcome('unavailable', { code: 'transport-failure', phase: 'transport' });
    }
  } };
}
