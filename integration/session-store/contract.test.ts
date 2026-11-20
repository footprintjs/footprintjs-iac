import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { postgresFixture, redisFixture } from './fixtures.ts';

for (const [backend, create] of [['Redis', redisFixture], ['PostgreSQL', postgresFixture]] as const) {
  test(backend + ' session store contract', async t => {
    const { issuer, reader, restricted, denied } = await create(t);
    await t.test('service reads a valid session and rejects an unknown token', async () => {
      const token = await issuer.issue('user\u0000🦉', 60_000);
      assert.equal(await reader.read(token), 'user\u0000🦉');
      assert.equal(await reader.read(randomUUID()), null);
      assert.equal(await reader.read('malformed'), null);
    });
    await t.test('database denies issue and revoke with the service login', async () => {
      const token = await issuer.issue('original', 60_000);
      await assert.rejects(restricted.issue('unauthorized', 60_000), denied);
      await assert.rejects(restricted.revoke(token), denied);
      assert.equal(await reader.read(token), 'original');
    });
    await t.test('same token becomes unreadable at expiry', async () => {
      const token = await issuer.issue('short-lived', 1000);
      assert.equal(await reader.read(token), 'short-lived');
      await setTimeout(1100);
      assert.equal(await reader.read(token), null);
      await assert.rejects(issuer.issue('too long', 60_001), /expiry/);
    });
    await t.test('revocation takes effect before expiry and can be repeated', async () => {
      const token = await issuer.issue('active', 60_000);
      assert.equal(await reader.read(token), 'active');
      await issuer.revoke(token);
      assert.equal(await reader.read(token), null);
      await issuer.revoke(token);
      assert.equal(await reader.read(token), null);
    });
  });
}
