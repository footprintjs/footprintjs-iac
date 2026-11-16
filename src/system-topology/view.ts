import { canonicalTopology, object } from './data.ts';
import { projectSystemTopology } from './project.ts';
import type { SystemTopologyDefinition, SystemTopologyObservations, SystemTopologyView } from './types.ts';
/** Browser-safe consistency reader; the Node reader also verifies declaration digest. */
export function readSystemTopologyView(input: unknown): SystemTopologyView {
    const value = object(input, ['version', 'kind', 'definition', 'observations', 'nodes', 'boundaries', 'connections', 'limitations']);
    if (value.version !== 1 || value.kind !== 'system-topology-view')
        throw Error('Unsupported system topology view');
    const projected = projectSystemTopology(value.definition as SystemTopologyDefinition, value.observations as SystemTopologyObservations);
    if (canonicalTopology(projected) !== canonicalTopology(value))
        throw Error('Topology display differs from its declared evidence');
    return projected;
}
