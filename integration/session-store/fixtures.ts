import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createClient } from '@redis/client';
import pg from 'pg';
import { postgresSessionAdapter, postgresSessionStore } from '../../src/session-store/postgres.ts';
import { redisSessionAdapter, redisSessionStore } from '../../src/session-store/redis.ts';
import { bindSessions } from '../../test/fixtures/session-store-design.ts';
import { testServer } from './docker.ts';

function secret() { return randomBytes(24).toString('hex'); }

export async function redisFixture(t: TestContext) {
  const password = secret(), readerPassword = secret();
  const { port, cleanup } = await testServer(t, 'redis:7.4-alpine', 6379, ['--tmpfs', '/data'],
    ['sh', '-ec', 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly no --save ""'],
    { REDIS_PASSWORD: password }, ['sh', '-ec', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -qx PONG']);
  async function connect(username: string, password: string) {
    const client = createClient({ username, password, socket: { host: '127.0.0.1', port, reconnectStrategy: false } });
    client.on('error', () => {}); // Command promises surface transport failures to the test.
    await client.connect();
    cleanup.defer(() => { if (client.isOpen) client.destroy(); });
    return (args: string[]) => client.sendCommand(args);
  }
  const { binding, service, store } = bindSessions(redisSessionAdapter, 'read', { absolute: '1m' });
  const runtime = redisSessionStore(binding, store);
  const admin = await connect('default', password);
  await runtime.configureReader(admin, service, readerPassword);
  const reader = await connect(runtime.readerRole(service), readerPassword);
  return { issuer: runtime.issuer(admin), reader: runtime.reader(reader), restricted: runtime.issuer(reader),
    denied: (e: unknown) => e instanceof Error && e.message.startsWith('NOPERM') };
}

export async function postgresFixture(t: TestContext) {
  const password = secret(), readerPassword = secret();
  const { port, cleanup } = await testServer(t, 'postgres:17-alpine', 5432, ['--tmpfs', '/var/lib/postgresql/data'], [],
    { POSTGRES_PASSWORD: password }, ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
  async function connect(user: string, password: string) {
    const client = new pg.Client({ user, password, host: '127.0.0.1', port, database: 'postgres' });
    await client.connect();
    cleanup.defer(async () => { await client.end(); });
    return (text: string, values?: unknown[]) => client.query(text, values);
  }
  const { binding, service, store } = bindSessions(postgresSessionAdapter, 'read', { absolute: '1m' });
  const runtime = postgresSessionStore(binding, store);
  const admin = await connect('postgres', password);
  await runtime.install(admin);
  // Fresh service login. The only membership is the access role generated for its .uses(store, 'read').
  await admin(`CREATE ROLE api_test LOGIN PASSWORD '${readerPassword}' IN ROLE ${runtime.readerRole(service)}`);
  const reader = await connect('api_test', readerPassword);
  const serviceReader = runtime.reader(reader);
  const issuer = runtime.issuer(admin);
  await t.test('an old transaction snapshot cannot expose a revoked session', async () => {
    const token = await issuer.issue('snapshot', 60_000);
    await reader('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await reader('SELECT 1');
      await issuer.revoke(token);
      await assert.rejects(serviceReader.read(token), { code: '25000' });
    } finally { await reader('ROLLBACK'); }
    assert.equal(await serviceReader.read(token), null);
  });
  return { issuer, reader: serviceReader, restricted: runtime.issuer(reader),
    denied: (e: unknown) => e instanceof pg.DatabaseError && e.code === '42501' };
}
