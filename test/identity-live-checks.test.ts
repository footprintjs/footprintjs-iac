import assert from 'node:assert/strict';
import test from 'node:test';
import { neoIdentityCheckAdapter, neoIdentityChecks, type NeoIdentityCheckOptions } from '../integration/identity/checks.ts';
import { IdentityResponseError, readIdentityJson } from '../integration/identity/http.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { checkIdentityAccess, type IdentityAuthentication, type IdentityCheckRequest } from '../src/identity/index.ts';

const target: IdentityTarget = {
  version: 1, id: 'a1b2c3d4', directory: '/unused/private-fixture', context: 'kind-footprint-iac-identity-a1b2c3d4',
  kubeconfig: '/unused/kubeconfig', namespace: 'footprint-iac-identity-a1b2c3d4', stateDirectory: '/unused/state',
  neoPort: 15290, providerPort: 15291, ldapPort: 15292, issuer: 'http://127.0.0.1:15291/realms/neo',
  providerName: 'footprint-identity-a1b2c3d4-provider', directoryName: 'footprint-identity-a1b2c3d4-directory',
  fixtureDigest: 'a'.repeat(64), images: { nodeImage: 'node', pythonImage: 'python', ldapImage: 'ldap', providerImage: 'provider' },
};
const request = (id: string): IdentityCheckRequest => neoIdentityChecks.find(check => check.id === id)!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const healthy: IdentityAuthentication = { status: 'authenticated', subject: { id: 'directory-user-id', source: 'neo-directory', groups: ['neo-readers'] } };
async function harness(responses: Response[] = [], source: () => Promise<IdentityAuthentication> = async () => healthy) {
  const calls: { url: string; init?: RequestInit }[] = []; let directoryCalls = 0;
  const configuration: NeoIdentityCheckOptions = {
    directory: { id: 'test-directory', async authenticate() { directoryCalls++; return source(); } },
    readCredentials: async () => ({ alice: 'alice-private-canary', bob: 'bob-private-canary', directoryAdmin: 'directory-private-canary' }),
    fetch: async (url, init) => { calls.push({ url: String(url), init }); const response = responses.shift(); if (!response) throw new Error('Unexpected private-canary request'); return response; },
  };
  return { adapter: await neoIdentityCheckAdapter(target, configuration), calls, directoryCalls: () => directoryCalls };
}

test('bounded identity JSON counts bytes, cancels oversized streams and never retains response bodies in errors', async () => {
  let cancelled = false;
  const encoded = new TextEncoder().encode(JSON.stringify({ message: 'é'.repeat(12) }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded.subarray(0, 10)); controller.enqueue(encoded.subarray(10)); },
    cancel() { cancelled = true; } });
  const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => readIdentityJson(response, encoded.length - 1), error => error instanceof IdentityResponseError && error.code === 'response-too-large');
  assert.equal(cancelled, true);
  const exact = await readIdentityJson(json({ value: 'é' }), new TextEncoder().encode(JSON.stringify({ value: 'é' })).byteLength);
  assert.deepEqual(exact, { value: 'é' });
  let headerCancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { headerCancelled = true; } }), { headers: { 'content-type': 'application/json', 'content-length': '1000' } });
  await assert.rejects(() => readIdentityJson(declared, 10), /byte limit/); assert.equal(headerCancelled, true);
  for (const invalid of [new Response('<html>response-private-canary</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    new Response('response-private-canary', { headers: { 'content-type': 'application/json' } }), json([]), json(null)]) {
    await assert.rejects(() => readIdentityJson(invalid, 1024), error => error instanceof IdentityResponseError && !error.message.includes('private-canary'));
  }
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream-private-canary')); } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => readIdentityJson(broken, 1024), error => error instanceof IdentityResponseError && error.code === 'response-read-failed' && !error.message.includes('private-canary'));
});

test('live acceptance records real observed login/access verdicts and passes actual negative checks', async () => {
  const live = await harness([
    json({ access_token: 'reader-token-private-canary' }), json({ error: 'invalid_grant' }, 400),
    json({ error: 'Sign in required' }, 401), json({ sessions: [] }),
    json({ access_token: 'guest-token-private-canary' }), json({ error: 'Access refused' }, 403), json({ error: 'Sign in required' }, 401),
  ]);
  const run = await checkIdentityAccess({ stack: 'neo', checks: neoIdentityChecks, adapter: live.adapter });
  assert.equal(run.ok, true);
  assert.deepEqual(Object.values(run.checks).map(check => check.observation.verdict), ['available', 'authenticated', 'rejected', 'denied', 'allowed', 'denied', 'denied']);
  assert.equal(live.directoryCalls(), 1); assert.equal(live.calls.length, 7);
  assert.ok(live.calls.every(call => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal));
  assert.equal((live.calls[3]!.init!.headers as Record<string, string>).authorization, 'Bearer reader-token-private-canary');
  assert.equal((live.calls[5]!.init!.headers as Record<string, string>).authorization, 'Bearer guest-token-private-canary');
  assert.ok(!JSON.stringify(run).includes('private-canary'));
});

test('a new HTTP 200 without a valid current token cannot authenticate or reuse an older cached token', async () => {
  for (const body of [{}, { access_token: '' }, { access_token: 'x'.repeat(16 * 1024) }]) {
    const live = await harness([json({ access_token: 'old-private-canary' }), json(body)]);
    assert.equal((await live.adapter.check(request('login-alice'))).verdict, 'authenticated');
    const incomplete = await live.adapter.check(request('login-alice'));
    assert.equal(incomplete.verdict, 'unavailable'); assert.equal(incomplete.details!.code, 'identity-unavailable');
    assert.equal((await live.adapter.check(request('reader-allowed'))).verdict, 'unavailable');
    assert.equal(live.calls.length, 2);
  }
});

test('wrong-password checks preserve the legitimate reader token but unexpected token issuance fails the negative expectation', async () => {
  const live = await harness([json({ access_token: 'reader-private-canary' }), json({ access_token: 'wrong-password-private-canary' }), json({ sessions: [] })]);
  const run = await checkIdentityAccess({ stack: 'neo', checks: [request('login-alice'), request('login-wrong-password'), request('reader-allowed')], adapter: live.adapter });
  assert.equal(run.ok, false); assert.equal(run.checks['login-wrong-password']!.observation.verdict, 'authenticated');
  assert.equal(run.checks['login-wrong-password']!.status, 'failed');
  assert.equal((live.calls[2]!.init!.headers as Record<string, string>).authorization, 'Bearer reader-private-canary');
});

test('directory failure keeps invalid_grant unavailable rather than claiming a verified bad-password rejection, and recovery is fresh', async () => {
  let available = false;
  const live = await harness([json({ error: 'invalid_grant', error_description: 'private-canary-directory-error' }, 400), json({ error: 'invalid_grant' }, 400)],
    async () => available ? healthy : { status: 'unavailable', code: 'connection-refused' });
  assert.equal((await live.adapter.check(request('directory-available'))).verdict, 'unavailable');
  const failedLogin = await live.adapter.check(request('login-wrong-password'));
  assert.equal(failedLogin.verdict, 'unavailable'); assert.equal(failedLogin.details!.code, 'provider-unavailable');
  available = true;
  assert.equal((await live.adapter.check(request('directory-available'))).verdict, 'available');
  assert.equal((await live.adapter.check(request('login-wrong-password'))).verdict, 'rejected');
  assert.equal(live.directoryCalls(), 2); assert.ok(!JSON.stringify(failedLogin).includes('private-canary'));
});

test('unknown check IDs perform no LDAP or HTTP request and unrelated identity sources do not establish directory readiness', async () => {
  const live = await harness();
  const unknown = await live.adapter.check({ id: 'not-registered', label: 'Unknown', kind: 'access', expected: 'denied' });
  assert.equal(unknown.verdict, 'unavailable'); assert.equal(live.directoryCalls(), 0); assert.equal(live.calls.length, 0);
  const foreign = await harness([], async () => ({ status: 'authenticated', subject: { id: 'directory-user-id', source: 'foreign-directory', groups: ['neo-readers'] } }));
  assert.equal((await foreign.adapter.check(request('directory-available'))).verdict, 'unavailable');
});

test('reader and guest checks use measured session-array success and HTTP 403 only; malformed/HTML/backend responses remain unavailable', async () => {
  const cases = [
    { response: json({ sessions: [] }), verdict: 'allowed', code: 'access-allowed' },
    { response: json({ error: 'private-canary-refusal' }, 403), verdict: 'denied', code: 'access-denied' },
    { response: json({}), verdict: 'unavailable', code: 'backend-error' },
    { response: json({ sessions: 'not-an-array' }), verdict: 'unavailable', code: 'backend-error' },
    { response: json({ error: 'private-canary-backend' }, 500), verdict: 'unavailable', code: 'backend-error' },
    { response: json({ error: 'Sign in required' }, 401), verdict: 'unavailable', code: 'backend-error' },
    { response: new Response('<html>private-canary</html>', { status: 403, headers: { 'content-type': 'text/html' } }), verdict: 'unavailable', code: 'backend-error' },
    { response: new Response('not-json-private-canary', { headers: { 'content-type': 'application/json' } }), verdict: 'unavailable', code: 'backend-error' },
  ];
  for (const item of cases) {
    const live = await harness([json({ access_token: 'reader-private-canary' }), item.response]);
    await live.adapter.check(request('login-alice'));
    const actual = await live.adapter.check(request('reader-allowed'));
    assert.equal(actual.verdict, item.verdict); assert.equal(actual.details!.code, item.code);
    assert.ok(!JSON.stringify(actual).includes('private-canary'));
  }
  const guest = await harness([json({ access_token: 'guest-private-canary' }), json({ sessions: [] })]);
  const run = await checkIdentityAccess({ stack: 'neo', checks: [request('guest-denied')], adapter: guest.adapter });
  assert.equal(run.ok, false); assert.equal(run.checks['guest-denied']!.observation.verdict, 'allowed');
});

test('malformed and oversized login responses cannot mint successful observations or retain body secrets', async () => {
  for (const response of [new Response('<html>private-canary</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('malformed-private-canary', { headers: { 'content-type': 'application/json' } }), json({ padding: 'x'.repeat(64 * 1024), access_token: 'private-canary' })]) {
    const live = await harness([response]); const actual = await live.adapter.check(request('login-alice'));
    assert.equal(actual.verdict, 'unavailable'); assert.equal(actual.details!.code, 'backend-error'); assert.equal(actual.details!.httpStatus, 200);
    assert.ok(!JSON.stringify(actual).includes('private-canary'));
  }
});
