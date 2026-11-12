import { compileGraph } from '../../src/graph/compile.ts';
import { jsonCopy } from '../../src/graph/data.ts';
import type { JsonObject, StackState } from '../../src/types.ts';
import { canonical, fingerprint } from '../../src/util.ts';
import { createIdentityGraph } from './graph.ts';
import { createNeoConsumerGraph } from './create-consumer-graph.ts';
import type { IdentityTarget } from './target.ts';

export type NeoIdentityFaultAction = 'directory-down' | 'directory-restore' | 'provider-down' | 'provider-restore' | 'service-route-down' | 'service-route-restore';
export const NEO_UNAVAILABLE_SERVICE_PORT = 5999;
const actions: readonly NeoIdentityFaultAction[] = ['directory-down', 'directory-restore', 'provider-down', 'provider-restore', 'service-route-down', 'service-route-restore'];
const ports = (spec: JsonObject) => (spec.spec as JsonObject).ports as JsonObject[];

/** A fault graph changes one admitted field and preserves other supported, durably recorded faults. */
export function createNeoIdentityFaultGraph(target: IdentityTarget, input: StackState, action: NeoIdentityFaultAction) {
  if (!actions.includes(action)) throw Error('Unsupported Neo identity fault action');
  const state = jsonCopy(input) as unknown as StackState;
  const includeNeo = Object.hasOwn(state.resources, 'neo-app');
  const baseline = createIdentityGraph(target, { includeNeo });
  if (state.version !== 1 || state.stack !== baseline.name
    || canonical(Object.keys(state.resources).sort()) !== canonical(baseline.resources.map(resource => resource.id).sort())) {
    throw Error('Fault checks require the complete deployed identity inventory');
  }
  const resources = structuredClone(baseline.resources);
  const separatedApp = includeNeo ? createNeoConsumerGraph(target).resources.find(resource => resource.id === 'neo-app') : undefined;
  let separatedConsumer = false;
  for (const resource of resources) {
    const saved = state.resources[resource.id]!;
    if (!saved || saved.pending || typeof saved.physicalId !== 'string' || !saved.physicalId
      || saved.fingerprint !== fingerprint(saved.resource.spec)) throw Error('Fault inventory is incomplete or unresolved');
    if (resource.provider === 'local-identity-fixture') {
      if (typeof saved.resource.spec.enabled !== 'boolean') throw Error('Invalid recorded identity state');
      resource.spec.enabled = saved.resource.spec.enabled;
    }
    if (resource.id === 'neo-service') {
      const savedPort = ports(saved.resource.spec)[0]?.targetPort, declaredPort = ports(resource.spec)[0]?.targetPort;
      if (savedPort !== declaredPort && savedPort !== NEO_UNAVAILABLE_SERVICE_PORT) throw Error('Unsupported recorded Service route');
      ports(resource.spec)[0]!.targetPort = savedPort!;
    }
    if (canonical(resource) !== canonical(saved.resource)) {
      // The native parent flow already gates identity acquisition. Admit only its exact known consumer declaration.
      if (resource.id !== 'neo-app' || !separatedApp || canonical(saved.resource) !== canonical(separatedApp)) {
        throw Error('Fault inventory differs from the prepared identity graph');
      }
      resource.dependsOn = [...separatedApp.dependsOn!];
      separatedConsumer = true;
    }
  }
  const resourceId = action.startsWith('directory-') ? 'identity-directory' : action.startsWith('provider-') ? 'identity-provider' : 'neo-service';
  const selected = resources.find(resource => resource.id === resourceId);
  if (!selected) throw Error('Service route faults require the fully deployed Neo application');
  if (resourceId === 'neo-service') ports(selected.spec)[0]!.targetPort = action === 'service-route-down'
    ? NEO_UNAVAILABLE_SERVICE_PORT : ports(baseline.resources.find(resource => resource.id === resourceId)!.spec)[0]!.targetPort!;
  else selected.spec.enabled = action.endsWith('-restore');
  return { resourceId, graph: compileGraph({ name: baseline.name, resources, boundaries: [...baseline.boundaries],
    memberships: [...baseline.memberships], relations: baseline.relations.filter(relation => !(separatedConsumer
      && relation.kind === 'order' && relation.from === 'identity-provider' && relation.to === 'neo-app')) }) };
}
