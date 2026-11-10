import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LdapIdentityAdapter } from '../../src/identity-ldap/index.ts';
import { defineIdentitySource } from '../../src/identity/index.ts';
import { command } from './command.ts';
import type { IdentityTarget } from './target.ts';

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const digest = createHash('sha1').update(password).update(salt).digest();
  return '{SSHA}' + Buffer.concat([digest, salt]).toString('base64');
}
export async function writeIdentityFixture(target: IdentityTarget): Promise<void> {
  const ldap = join(target.directory, 'ldap'), provider = join(target.directory, 'provider');
  await mkdir(ldap, { recursive: true, mode: 0o700 }); await mkdir(provider, { recursive: true, mode: 0o755 });
  const credentials = { alice: randomBytes(24).toString('base64url'), bob: randomBytes(24).toString('base64url'),
    directoryAdmin: randomBytes(32).toString('base64url') };
  await writeFile(join(target.directory, 'credentials.json'), JSON.stringify(credentials) + '\n', { mode: 0o600 });
  await writeFile(join(target.directory, 'provider.env'), `LDAP_BIND_PASSWORD=${credentials.directoryAdmin}\n`, { mode: 0o600 });
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7',
    '-subj', `/CN=${target.directoryName}`, '-addext', `subjectAltName=DNS:${target.directoryName}`,
    '-keyout', join(ldap, 'ldap.key'), '-out', join(provider, 'ldap.crt')]);
  // A nested read-only mount needs its mountpoint present in the parent mount.
  await copyFile(join(provider, 'ldap.crt'), join(ldap, 'ldap.crt'));
  await writeFile(join(ldap, 'slapd.conf'), `include /etc/ldap/schema/core.schema\ninclude /etc/ldap/schema/cosine.schema\ninclude /etc/ldap/schema/inetorgperson.schema\npidfile /tmp/slapd.pid\nargsfile /tmp/slapd.args\nmodulepath /usr/lib/ldap\nmoduleload back_mdb\nTLSCertificateFile /fixtures/ldap.crt\nTLSCertificateKeyFile /fixtures/ldap.key\nTLSCACertificateFile /fixtures/ldap.crt\nTLSVerifyClient never\ndatabase mdb\nmaxsize 1073741824\nsuffix "dc=footprint,dc=local"\nrootdn "cn=admin,dc=footprint,dc=local"\nrootpw ${passwordHash(credentials.directoryAdmin)}\ndirectory /var/lib/ldap-fixture\nindex objectClass eq\nindex uid eq\naccess to attrs=userPassword by self write by anonymous auth by * none\naccess to * by users read by * none\n`, { mode: 0o600 });
  const entries = [
    'dn: dc=footprint,dc=local\nobjectClass: top\nobjectClass: dcObject\nobjectClass: organization\no: FootPrint local identity fixture\ndc: footprint',
    'dn: ou=people,dc=footprint,dc=local\nobjectClass: organizationalUnit\nou: people',
    'dn: ou=groups,dc=footprint,dc=local\nobjectClass: organizationalUnit\nou: groups',
    ...(['alice', 'bob'] as const).map(user => `dn: uid=${user},ou=people,dc=footprint,dc=local\nobjectClass: inetOrgPerson\nuid: ${user}\ncn: ${user}\nsn: ${user}\nmail: ${user}@footprint.local\nuserPassword: ${passwordHash(credentials[user])}`),
    'dn: cn=neo-readers,ou=groups,dc=footprint,dc=local\nobjectClass: groupOfNames\ncn: neo-readers\nmember: uid=alice,ou=people,dc=footprint,dc=local',
    'dn: cn=neo-guests,ou=groups,dc=footprint,dc=local\nobjectClass: groupOfNames\ncn: neo-guests\nmember: uid=bob,ou=people,dc=footprint,dc=local',
  ];
  await writeFile(join(ldap, 'seed.ldif'), entries.join('\n\n') + '\n', { mode: 0o600 });
  const federation = new LdapIdentityAdapter().bind(defineIdentitySource({ id: 'neo-directory', kind: 'directory', ownership: 'managed' }), {
    url: `ldaps://${target.directoryName}:1636`, usersDn: 'ou=people,dc=footprint,dc=local', groupsDn: 'ou=groups,dc=footprint,dc=local',
    bindDn: 'cn=admin,dc=footprint,dc=local', bindSecret: { environment: 'LDAP_BIND_PASSWORD' }, trust: { certificatePath: '/fixtures/ldap.crt' },
  });
  const audience = { name: 'neo-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
    config: { 'included.client.audience': 'neo', 'id.token.claim': 'false', 'access.token.claim': 'true' } };
  const groups = { name: 'directory-groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper',
    config: { 'full.path': 'false', 'claim.name': 'groups', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' } };
  const realm = { realm: 'neo', enabled: true, sslRequired: 'none', registrationAllowed: false, resetPasswordAllowed: false,
    accessTokenLifespan: 60, ssoSessionIdleTimeout: 300, loginWithEmailAllowed: false, duplicateEmailsAllowed: false,
    components: { 'org.keycloak.storage.UserStorageProvider': [federation.component] },
    clients: [
      { clientId: 'neo', enabled: true, publicClient: true, protocol: 'openid-connect', standardFlowEnabled: true,
        directAccessGrantsEnabled: false, redirectUris: [`http://127.0.0.1:${target.neoPort}/?oidcCallback=1`],
        webOrigins: [`http://127.0.0.1:${target.neoPort}`], attributes: { 'pkce.code.challenge.method': 'S256' }, protocolMappers: [audience, groups] },
      { clientId: 'neo-checks', enabled: true, publicClient: true, protocol: 'openid-connect', standardFlowEnabled: false,
        directAccessGrantsEnabled: true, protocolMappers: [audience, groups] },
    ],
  };
  await writeFile(join(provider, 'neo-realm.json'), JSON.stringify(realm, null, 2) + '\n', { mode: 0o644 });
}
