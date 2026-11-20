import { randomUUID } from 'node:crypto';
import type { BindingResult } from '../binding/types.ts';
import type { StoreHandle } from '../system/handles.ts';
import { sessionCapabilityAdapter } from './binding.ts';
import { decodeSession, encodeSession, validToken, type SessionStoreAdapter } from './contract.ts';
import { sessionLayout } from './layout.ts';

export const postgresSessionAdapter = sessionCapabilityAdapter('postgres-session-store');
export type PostgresSessionQuery = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface PostgresSessionStore extends SessionStoreAdapter<PostgresSessionQuery> {
  install(admin: PostgresSessionQuery): Promise<void>;
}

export function postgresSessionStore(binding: BindingResult, store: StoreHandle): PostgresSessionStore {
  const layout = sessionLayout(binding, store, postgresSessionAdapter.id);
  // Identifiers are derived from hashes only. All session data travels via driver parameters.
  const { namespace: schema } = layout;
  const table = schema + '.sessions';
  const lookup = schema + '.read_session';
  return {
    readerRole: layout.readerRole,
    /** First installation on an existing database. One atomic SQL command, failing on any name collision. */
    async install(admin: PostgresSessionQuery) {
      const grants = layout.roles.map(role => `
        CREATE ROLE ${role} NOLOGIN;
        GRANT USAGE ON SCHEMA ${schema} TO ${role};
        GRANT EXECUTE ON FUNCTION ${lookup}(uuid) TO ${role};`).join('\n');
      await admin(`
        CREATE SCHEMA ${schema};
        REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
        CREATE TABLE ${table} (token uuid PRIMARY KEY, value text NOT NULL, expires_at timestamptz NOT NULL,
          revoked boolean NOT NULL DEFAULT false);
        REVOKE ALL ON TABLE ${table} FROM PUBLIC;
        CREATE FUNCTION ${lookup}(candidate uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
          SET search_path = pg_catalog, pg_temp AS $read$
          BEGIN
            IF pg_catalog.current_setting('transaction_isolation') IN ('repeatable read', 'serializable')
               OR pg_catalog.pg_is_in_recovery() THEN
              RAISE EXCEPTION 'Session reads require a current primary snapshot' USING ERRCODE = '25000';
            END IF;
            RETURN (SELECT value FROM ${table}
              WHERE token = candidate AND NOT revoked AND expires_at > pg_catalog.clock_timestamp());
          END;
          $read$;
        REVOKE ALL ON FUNCTION ${lookup}(uuid) FROM PUBLIC;
        ${grants}`);
    },
    reader(query) {
      return { async read(token) {
        if (!validToken(token)) return null;
        const { rows } = await query(`SELECT ${lookup}($1::uuid) AS value`, [token]);
        return decodeSession(rows[0]?.value);
      } };
    },
    issuer(query) {
      return {
        async issue(value, lifetimeMs) {
          layout.validateLifetime(lifetimeMs);
          const token = randomUUID();
          await query(`INSERT INTO ${table} (token, value, expires_at)
            VALUES ($1, $2, pg_catalog.clock_timestamp() + $3::bigint * interval '1 millisecond')`,
            [token, encodeSession(value), lifetimeMs]);
          return token;
        },
        async revoke(token) {
          if (validToken(token)) await query(`UPDATE ${table} SET revoked = true WHERE token = $1`, [token]);
        },
      };
    },
  };
}
