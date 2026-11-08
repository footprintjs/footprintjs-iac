import { freeze } from '../../src/graph/data.ts';
import { fingerprint } from '../../src/util.ts';
import type { BindingProfile, CapabilityAdapter } from '../../src/binding/types.ts';
import { NEO_NAMESPACE } from './stack.ts';
import { readOptions, type NeoKubernetesOptions } from './profile/options.ts';
import { neoSupport } from './profile/support.ts';
import { lowerNeoCompute } from './profile/lower-compute.ts';
import { lowerNeoEndpoint } from './profile/lower-endpoint.ts';

const compute: CapabilityAdapter = {
  id: 'neo-local-kubernetes-compute', mode: 'real',
  supports: (capability, context) => neoSupport(capability, context, 'compute'),
  lower: lowerNeoCompute,
};
const endpoint: CapabilityAdapter = {
  id: 'neo-local-kubernetes-endpoint', mode: 'real',
  supports: (capability, context) => neoSupport(capability, context, 'endpoint'),
  lower: lowerNeoEndpoint,
};
/** A real, narrow local consumer implementation. This is not a generic Kubernetes capability profile. */
export function neoKubernetesProfile(options: NeoKubernetesOptions): BindingProfile {
  const selected = readOptions(options);
  const target = {
    id: 'neo-k8s-' + fingerprint({ context: selected.context, namespace: NEO_NAMESPACE }).slice(0, 20),
    properties: { context: selected.context, namespace: NEO_NAMESPACE, fixture: 'neo-local-ephemeral' },
  };
  return freeze({
    id: 'neo-local-kubernetes-fixture', target,
    rules: [
      { id: 'neo-service-fixture', family: 'compute', kind: 'service', adapterId: compute.id },
      { id: 'neo-http-fixture', family: 'network', kind: 'endpoint', adapterId: endpoint.id },
    ],
    adapters: [compute, endpoint],
    artifacts: { 'neo-program': { kind: 'neo-local-fixture', nodeImage: selected.nodeImage, pythonImage: selected.pythonImage } },
  });
}
export type { NeoKubernetesOptions } from './profile/options.ts';
