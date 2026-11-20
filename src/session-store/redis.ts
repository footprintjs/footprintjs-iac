import { createHash, randomUUID } from 'node:crypto';
import type { BindingResult } from '../binding/types.ts';
import type { ServiceHandle, StoreHandle } from '../system/handles.ts';
import { sessionCapabilityAdapter } from './binding.ts';
import { decodeSession, encodeSession, validToken, type SessionStoreAdapter } from './contract.ts';
import { sessionLayout } from './layout.ts';

export const redisSessionAdapter = sessionCapabilityAdapter('redis-session-store');
export type RedisSessionCommand = (args: string[]) => Promise<unknown>;

export interface RedisSessionStore extends SessionStoreAdapter<RedisSessionCommand> {
  configureReader(admin: RedisSessionCommand, service: ServiceHandle, password: string): Promise<void>;
}

export function redisSessionStore(binding: BindingResult, store: StoreHandle): RedisSessionStore {
  const layout = sessionLayout(binding, store, redisSessionAdapter.id);
  const prefix = layout.namespace + ':';
  return {
    readerRole: layout.readerRole,
    /** Sets the credential and replaces grants only for the derived, dedicated service user. */
    async configureReader(admin: RedisSessionCommand, service: ServiceHandle, password: string) {
      const user = layout.readerRole(service);
      if (!password) throw new Error('A Redis reader credential is required');
      const hash = createHash('sha256').update(password).digest('hex');
      await admin(['ACL', 'SETUSER', user, 'reset', 'on', '#' + hash, '~' + prefix + '*', '+get']);
    },
    reader(command) {
      return { async read(token) {
        if (!validToken(token)) return null;
        return decodeSession(await command(['GET', prefix + token]));
      } };
    },
    issuer(command) {
      return {
        async issue(value, lifetimeMs) {
          layout.validateLifetime(lifetimeMs);
          const token = randomUUID();
          const result = await command(['SET', prefix + token, encodeSession(value), 'PX', String(lifetimeMs), 'NX']);
          if (result !== 'OK') throw new Error('Redis did not create the session');
          return token;
        },
        async revoke(token) {
          if (validToken(token)) await command(['DEL', prefix + token]);
        },
      };
    },
  };
}
