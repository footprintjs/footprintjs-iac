import type { ProviderContext, Resource } from '../../src/types.ts';
import { fingerprint } from '../../src/util.ts';
import { command } from './command.ts';
import type { IdentityTarget } from './target.ts';

/** Existing-object operations only: never invoke create, apply, remove or a shell. */
export async function executeNeoIdentityFaultEffect(target: IdentityTarget, resource: Resource, physicalId: string,
  context: ProviderContext, runner: typeof command = command): Promise<void> {
  if (resource.provider === 'local-identity-fixture') {
    if (!/^[a-f0-9]{64}$/.test(physicalId) || typeof resource.spec.enabled !== 'boolean'
      || !['identity-directory', 'identity-provider'].includes(resource.id)) throw Error('Invalid owned identity fault effect');
    await runner('docker', [resource.spec.enabled ? 'start' : 'stop', physicalId], 30_000); return;
  }
  const metadata = resource.spec.metadata as Record<string, unknown>;
  const port = ((resource.spec.spec as Record<string, unknown>).ports as Record<string, unknown>[])[0]?.targetPort;
  if (resource.id !== 'neo-service' || resource.provider !== 'kubernetes' || resource.spec.kind !== 'Service'
    || metadata.name !== 'neo' || metadata.namespace !== target.namespace || !['http', 5999].includes(port as string | number)) throw Error('Invalid owned Service fault effect');
  const base = ['--kubeconfig', target.kubeconfig, '--context', target.context, '--namespace', target.namespace, '--request-timeout', '10s'];
  const live = JSON.parse(await runner('kubectl', [...base, 'get', 'service', 'neo', '--output=json'], 12_000));
  const meta = live.metadata, marks = meta?.annotations;
  if (live.apiVersion !== 'v1' || live.kind !== 'Service' || meta?.name !== 'neo' || meta.namespace !== target.namespace || meta.deletionTimestamp
    || typeof meta.uid !== 'string' || !meta.uid || typeof meta.resourceVersion !== 'string' || !meta.resourceVersion
    || marks?.['footprint-iac.dev/owner'] !== fingerprint({ stack: context.stack, id: resource.id })
    || marks?.['footprint-iac.dev/stack'] !== context.stack || marks?.['footprint-iac.dev/resource'] !== resource.id) throw Error('Service fault ownership changed');
  const patch = [
    { op: 'test', path: '/metadata/uid', value: meta.uid }, { op: 'test', path: '/metadata/resourceVersion', value: meta.resourceVersion },
    { op: 'test', path: '/metadata/annotations/footprint-iac.dev~1owner', value: marks['footprint-iac.dev/owner'] },
    { op: 'replace', path: '/spec/ports/0/targetPort', value: port },
  ];
  await runner('kubectl', [...base, 'patch', 'service', 'neo', '--type=json', '--field-manager=footprint-iac', '--patch', JSON.stringify(patch)], 12_000);
}
