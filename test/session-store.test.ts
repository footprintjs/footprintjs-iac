import assert from 'node:assert/strict';
import test from 'node:test';
import { why } from '../src/binding/index.ts';
import { postgresSessionAdapter, postgresSessionStore } from '../src/session-store/postgres.ts';
import { redisSessionAdapter, redisSessionStore } from '../src/session-store/redis.ts';
import { bindSessions } from './fixtures/session-store-design.ts';

for (const [adapter, open] of [[redisSessionAdapter, redisSessionStore], [postgresSessionAdapter, postgresSessionStore]] as const) {
  test(adapter.id + ' admits only supported session and service access requirements', () => {
    const { binding, store, service, other } = bindSessions(adapter, 'read', { absolute: '30m' });
    const expiration = why(binding, store, 'expiration')!;
    const resource = binding.graph.resources.find(r => r.provider === adapter.id)!;
    assert.deepEqual(expiration.outputs, [{ property: 'expiration', resourceId: resource.id, path: '/maxLifetimeMs' }]);
    assert.equal(resource.spec.maxLifetimeMs, 1_800_000);
    assert.deepEqual(resource.spec.readers, ['api']);
    const runtime = open(binding, store);
    assert.match(runtime.readerRole(service), /^ic_read_/);
    assert.throws(() => runtime.readerRole(other), /no declared read/);
    assert.throws(() => runtime.readerRole(bindSessions(adapter).service), /different or discarded/);
    const wrong = adapter === redisSessionAdapter ? postgresSessionStore : redisSessionStore;
    assert.throws(() => wrong(binding, store), /different binding adapter/);
    for (const access of ['write', 'readWrite'] as const) assert.throws(() => bindSessions(adapter, access), /Unsupported capability.*api\./);
    assert.throws(() => bindSessions(adapter, 'read', { idle: '30m' }), /Unsupported capability.*expiration/);
    assert.throws(() => bindSessions(adapter, 'read', { absolute: '9007199254740991d' }), /Unsupported capability.*expiration/);
  });
}
