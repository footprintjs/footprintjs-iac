import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from './command.ts';
import { writeIdentityFixture } from './fixture.ts';
import { identityRoot, type IdentityTarget } from './target.ts';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(accept => server.close(() => accept())); return port;
}
const args = process.argv.slice(2);
const descriptorPath = args[0];
if (!descriptorPath) throw new Error('Usage: npm run identity:prepare -- /path/to/prepared-local-cluster.json [node-image]');
const cluster = JSON.parse(await readFile(resolve(descriptorPath), 'utf8')) as { context: string; kubeconfig: string; images: { nodeImage: string; pythonImage: string }; sourceCommit: string };
if (!/^kind-footprint-iac-(recording-[a-f0-9]{8}|identity-[a-f0-9]{8})$/.test(cluster.context)) throw new Error('Use an isolated prepared local FootPrint cluster');
await command('kubectl', ['--kubeconfig', cluster.kubeconfig, '--context', cluster.context, 'get', '--raw=/readyz']);
const id = randomBytes(4).toString('hex'), directory = resolve(identityRoot, id);
await mkdir(directory, { recursive: true, mode: 0o700 });
const target: IdentityTarget = {
  version: 1, id, directory, context: cluster.context, kubeconfig: cluster.kubeconfig, namespace: `footprint-iac-identity-${id}`,
  stateDirectory: resolve(directory, 'state'), neoPort: await freePort(), providerPort: await freePort(), ldapPort: await freePort(),
  issuer: '', fixtureDigest: '', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
  images: { nodeImage: args[1] ?? cluster.images.nodeImage, pythonImage: cluster.images.pythonImage,
    ldapImage: '', providerImage: '' }, sourceCommit: cluster.sourceCommit,
};
target.issuer = `http://127.0.0.1:${target.providerPort}/realms/neo`;
await command('docker', ['build', '-t', 'footprint-iac/identity-ldap:local', '-f', resolve(import.meta.dirname, 'OpenLDAP.Dockerfile'), import.meta.dirname], 180_000);
await command('docker', ['pull', 'quay.io/keycloak/keycloak:26.8.2'], 180_000);
target.images.ldapImage = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', 'footprint-iac/identity-ldap:local']);
target.images.providerImage = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', 'quay.io/keycloak/keycloak:26.8.2']);
await writeIdentityFixture(target);
const hash = createHash('sha256');
for (const path of ['ldap/slapd.conf', 'ldap/seed.ldif', 'provider/neo-realm.json', 'provider/ldap.crt', 'provider.env']) hash.update(await readFile(resolve(directory, path)));
target.fixtureDigest = hash.digest('hex');
for (const path of [resolve(directory, 'target.json'), resolve(identityRoot, 'latest.json')]) await writeFile(path, JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ target: resolve(directory, 'target.json'), context: target.context, namespace: target.namespace,
  neoUrl: `http://127.0.0.1:${target.neoPort}/?test`, issuer: target.issuer }, null, 2));
