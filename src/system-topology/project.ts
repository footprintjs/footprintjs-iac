import { freeze } from '../graph/data.ts';
import { readSystemTopologyDefinition, readSystemTopologyObservations } from './data.ts';
import { aggregate, checkState, componentState, isReady, references, selected } from './observed-state.ts';
import { projectNode } from './project-node.ts';
import type { SystemTopologyDefinition, SystemTopologyObservations, SystemTopologyView, TopologyConnectionView } from './types.ts';
/** Pure projection only. Hosts must admit native evidence before supplying completed observations. */
export function projectSystemTopology(definition: SystemTopologyDefinition, observations: SystemTopologyObservations): SystemTopologyView {
    const declared = readSystemTopologyDefinition(definition);
    const observed = readSystemTopologyObservations(observations);
    if (observed.targetId !== declared.binding.targetId || observed.graphDigest !== declared.binding.graphDigest || observed.definitionDigest !== declared.digest) {
        throw Error('Topology observations belong to another declaration or target');
    }
    const nodes = declared.nodes.map(node => projectNode(node, observed));
    const connections = declared.connections.map(edge => {
        const ids = edge.checkIds ?? [];
        const checks = observed.checks.filter(check => ids.includes(check.id));
        const state = checkState(ids, checks);
        const status: TopologyConnectionView['status'] = !ids.length || !checks.length || state === 'pending' ? 'untested'
            : state === 'ready' ? 'connected' : state as 'checking' | 'failed' | 'unknown' | 'incomplete';
        return { ...edge, status, evidence: references(checks) };
    });
    const parents = new Map(declared.boundaries.map(boundary => [boundary.id, boundary.parentId]));
    const contained = (id: string, boundaryId?: string): boolean => {
        for (let current = boundaryId; current; current = parents.get(current))
            if (current === id)
                return true;
        return false;
    };
    const boundaries = declared.boundaries.map(boundary => {
        const members = nodes.filter(node => contained(boundary.id, node.boundaryId));
        const rows = selected(boundary.bindings ?? { resourceIds: [] }, observed);
        const proofChecks = checkState(boundary.bindings?.checkIds ?? [], rows.checks);
        const proofComponents = componentState(boundary.bindings?.componentIds ?? [], rows.components);
        const requirements = [proofChecks, proofComponents].filter(state => state !== undefined);
        const verified = requirements.length > 0 && requirements.every(state => state === 'ready');
        const statuses = members.map(node => node.status);
        for (const state of requirements)
            if (state !== 'ready')
                statuses.push(state);
        const memberState = aggregate(statuses);
        return { ...boundary, status: memberState === 'ready' && !verified ? 'unknown' as const : memberState,
            observed: verified, progress: { completed: members.filter(node => isReady(node.status)).length, total: members.length,
                indeterminate: !verified || members.some(node => ['unknown', 'incomplete'].includes(node.status)) },
            evidence: references([...rows.resources, ...rows.components, ...rows.checks]) };
    });
    return freeze({ version: 1, kind: 'system-topology-view', definition: declared, observations: observed,
        nodes, boundaries, connections, limitations: [
            'Topology and technology describe registered intent; native observations separately establish installed, running and connected facts.',
            'Recorded candidate dependencies do not establish unobserved external service internals.',
        ] });
}
