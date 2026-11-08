import { artifact, ref, system, type SystemDesign } from '../../src/system/index.ts';
import { jsonCopy, keys, object } from '../../src/graph/data.ts';
import { NEO_NAMESPACE } from './stack.ts';

/** This fixture uses two real containers in one Pod; it requests no production storage/identity. */
export function createNeoSystem(options: { replicas?: number } = {}): SystemDesign {
  const requested = object(jsonCopy(options), 'Neo system options');
  keys(requested, ['replicas'], 'Neo system option');
  const replicas = requested.replicas ?? 1;
  if (replicas !== 1 && replicas !== 2) throw new Error('The local Neo fixture supports one or two replicas');
  return system(NEO_NAMESPACE)
    .addCompute('application', compute => compute.addService('neo-app', service => service
      .program(artifact('neo-program')).replicas(replicas)))
    .addNetwork('network', network => network.addEndpoint('neo-http', endpoint => endpoint
      .protocol('http').port(5230).target(ref.service('application.neo-app'))))
    .build();
}
