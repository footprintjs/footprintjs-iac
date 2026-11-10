import { resolve } from 'node:path';
import { jsonCopy } from '../../src/graph/data.ts';
import { canonical } from '../../src/util.ts';
import type { IdentityContainerSpec } from './docker-types.ts';

/** The fixture has two fixed roles; no command, mount or secret value is accepted from an arbitrary graph. */
export function readIdentityContainerSpec(input: unknown, targetId: string, root: string): IdentityContainerSpec {
  try {
    const spec = jsonCopy(input) as unknown as IdentityContainerSpec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
      || Object.keys(spec).some(key => !['name', 'image', 'network', 'enabled', 'role', 'configDigest', 'mounts', 'environment', 'envFile', 'port', 'containerPort', 'command', 'health'].includes(key))
      || !['directory', 'provider'].includes(spec.role) || spec.name !== `footprint-identity-${targetId}-${spec.role}`
      || !/^sha256:[a-f0-9]{64}$/.test(spec.image) || spec.network !== 'kind' || typeof spec.enabled !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(spec.configDigest) || !Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535
      || !Array.isArray(spec.mounts) || !Array.isArray(spec.environment) || !Array.isArray(spec.command)) throw Error();
    const directory = resolve(root, targetId), certificate = resolve(directory, 'provider/ldap.crt');
    const mounts = spec.role === 'directory'
      ? [{ source: resolve(directory, 'ldap'), target: '/fixtures' }, { source: certificate, target: '/fixtures/ldap.crt' }]
      : [{ source: resolve(directory, 'provider/neo-realm.json'), target: '/opt/keycloak/data/import/neo-realm.json' }, { source: certificate, target: '/fixtures/ldap.crt' }];
    if (canonical(spec.mounts) !== canonical(mounts)) throw Error();
    if (spec.role === 'directory') {
      if (spec.containerPort !== 1636 || spec.envFile !== undefined || spec.environment.length || spec.command.length
        || canonical(spec.health) !== canonical({ caFile: certificate, serverName: spec.name })) throw Error();
    } else {
      const issuer = `http://127.0.0.1:${spec.port}/realms/neo`;
      if (spec.containerPort !== 8080 || spec.envFile !== resolve(directory, 'provider.env')
        || canonical(spec.command) !== canonical(['start-dev', '--import-realm', '--cache=local'])
        || canonical(spec.health) !== canonical({ url: issuer + '/.well-known/openid-configuration', issuer })) throw Error();
      const expected = [`KC_HOSTNAME=http://127.0.0.1:${spec.port}`, 'KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true', 'KC_TRUSTSTORE_PATHS=/fixtures/ldap.crt'];
      if (spec.environment.length !== 4 || expected.some(value => !spec.environment.includes(value))
        || !spec.environment.some(value => /^JAVA_OPTS_KC_HEAP=-Xms\d{1,4}m -Xmx\d{1,4}m$/.test(value))) throw Error();
    }
    return spec;
  } catch { throw new Error('Unsupported local identity fixture declaration'); }
}
