import { join } from 'node:path';
import type { JsonObject, Resource } from '../../src/types.ts';
import { compileGraph } from '../../src/graph/compile.ts';
import { createNeoStack } from '../neo/stack.ts';
import type { IdentityContainerSpec } from './docker-types.ts';
import type { IdentityTarget } from './target.ts';
import { neoAccessPolicy } from './policy.ts';

export function createIdentityGraph(target: IdentityTarget, options: { includeNeo?: boolean; directoryEnabled?: boolean; providerEnabled?: boolean } = {}) {
  const directory: IdentityContainerSpec = {
    name: target.directoryName, image: target.images.ldapImage, network: 'kind', enabled: options.directoryEnabled ?? true,
    role: 'directory', configDigest: target.fixtureDigest, environment: [], command: [],
    mounts: [{ source: join(target.directory, 'ldap'), target: '/fixtures' },
      { source: join(target.directory, 'provider/ldap.crt'), target: '/fixtures/ldap.crt' }],
    port: target.ldapPort, containerPort: 1636,
    health: { caFile: join(target.directory, 'provider/ldap.crt'), serverName: target.directoryName },
  };
  const provider: IdentityContainerSpec = {
    name: target.providerName, image: target.images.providerImage, network: 'kind', enabled: options.providerEnabled ?? true,
    role: 'provider', configDigest: target.fixtureDigest, envFile: join(target.directory, 'provider.env'),
    environment: [`KC_HOSTNAME=http://127.0.0.1:${target.providerPort}`, 'KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true',
      'KC_TRUSTSTORE_PATHS=/fixtures/ldap.crt', 'JAVA_OPTS_KC_HEAP=-Xms128m -Xmx384m'],
    mounts: [{ source: join(target.directory, 'provider/neo-realm.json'), target: '/opt/keycloak/data/import/neo-realm.json' },
      { source: join(target.directory, 'provider/ldap.crt'), target: '/fixtures/ldap.crt' }],
    port: target.providerPort, containerPort: 8080, command: ['start-dev', '--import-realm', '--cache=local'],
    health: { url: target.issuer + '/.well-known/openid-configuration', issuer: target.issuer },
  };
  const resources: Resource[] = [
    { id: 'identity-directory', provider: 'local-identity-fixture', spec: directory as unknown as JsonObject },
    { id: 'identity-provider', provider: 'local-identity-fixture', dependsOn: ['identity-directory'], spec: provider as unknown as JsonObject },
  ];
  if (options.includeNeo) {
    if (!target.providerAddress || !/^\d+\.\d+\.\d+\.\d+$/.test(target.providerAddress)) throw new Error('Observe the identity provider address before binding Neo');
    const stack = createNeoStack(target.images);
    const appResources = JSON.parse(JSON.stringify(stack.resources).replaceAll('footprint-iac-neo-test', target.namespace)) as Resource[];
    const app = appResources.find(resource => resource.id === 'neo-app')!;
    app.dependsOn = [...app.dependsOn!, 'identity-provider', 'neo-access-policy'];
    const template = ((app.spec.spec as JsonObject).template as JsonObject).spec as JsonObject;
    const node = (template.containers as JsonObject[]).find(container => container.name === 'node')!;
    (node.env as JsonObject[]).push(
      { name: 'JWKS_URL', value: `http://${target.providerAddress}:8080/realms/neo/protocol/openid-connect/certs` },
      { name: 'JWT_ISSUER', value: target.issuer }, { name: 'JWT_AUDIENCE', value: 'neo' },
      { name: 'OIDC_AUTHORITY', value: target.issuer }, { name: 'OIDC_CLIENT_ID', value: 'neo' },
      { name: 'OIDC_REDIRECT_URI', value: `http://127.0.0.1:${target.neoPort}/?oidcCallback=1` },
      { name: 'SEO_IDENTITY_SOURCE', value: 'neo-directory' },
      { name: 'SEO_IDENTITY_LOCAL_FIXTURE', value: '1' },
      { name: 'SEO_ACCESS_POLICY_FILE', value: '/etc/neo-identity/policy.json' },
      { name: 'SEO_ACCESS_EVIDENCE_DIR', value: '/tmp/neo-access-evidence' },
    );
    node.volumeMounts = [{ name: 'access-policy', mountPath: '/etc/neo-identity', readOnly: true }];
    template.volumes = [{ name: 'access-policy', configMap: { name: 'neo-access-policy' } }];
    // The tool server is a trusted same-Pod dependency, never a second unauthenticated entry point.
    const python = (template.containers as JsonObject[]).find(container => container.name === 'python')!;
    python.env = [{ name: 'FOOTPRINT_IAC_SIDECAR_HOST', value: '127.0.0.1' }];
    delete python.ports;
    for (const name of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
      const probe = python[name] as JsonObject;
      delete probe.httpGet;
      probe.exec = { command: ['python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=2)"] };
    }
    resources.push(appResources[0]!, { id: 'neo-access-policy', provider: 'kubernetes', dependsOn: ['neo-namespace'], spec: {
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'neo-access-policy', namespace: target.namespace },
      data: { 'policy.json': JSON.stringify(neoAccessPolicy()) },
    } }, ...appResources.slice(1));
  }
  return compileGraph({ name: `neo-identity-${target.id}`, resources,
    boundaries: [{ id: 'identity', kind: 'group', label: 'Identity and access' }, { id: 'neo', kind: 'group', label: 'Neo application' }],
    memberships: resources.map(resource => ({ resourceId: resource.id, boundaryId: resource.id.startsWith('identity-') ? 'identity' : 'neo' })),
    relations: [
      { from: 'identity-provider', to: 'identity-directory', kind: 'communicatesWith', label: 'LDAPS user authentication and groups' },
      ...(options.includeNeo ? [
        { from: 'neo-app', to: 'identity-provider', kind: 'communicatesWith' as const, label: 'OIDC tokens and signing keys' },
        { from: 'neo-service', to: 'neo-app', kind: 'communicatesWith' as const, label: 'Neo HTTP entry point' },
      ] : []),
    ],
  });
}
