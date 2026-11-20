import { communicationFields } from '../graph/communication.ts';
import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import type { SystemTopologyDefinition, SystemTopologyInput, SystemTopologyObservations, TopologyBindings, TopologyEvidenceReference } from './types.ts';
export const canonicalTopology = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalTopology).join(',')}]` : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalTopology((value as Record<string, unknown>)[key])).join(',')}}`;
export function object(input: unknown, allowed: readonly string[]) {
    const value = jsonCopy(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
        throw Error('Invalid system topology fields');
    return value as Record<string, unknown>;
}
export function text(value: unknown, max = 160): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
        throw Error('Invalid system topology text');
    return value;
}
export function digest(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw Error('Invalid system topology digest');
    return value;
}
const id = (value: unknown) => identifier(value, 'system topology identifier');
const list = (value: unknown, max: number) => {
    if (!Array.isArray(value) || value.length > max)
        throw Error('Bound system topology entries');
    return value;
};
function ids(value: unknown) {
    const result = list(value, 128).map(id);
    if (new Set(result).size !== result.length)
        throw Error('Duplicate system topology binding');
    return result;
}
function technology(input: unknown) {
    const value = object(input, ['id', 'label', 'version']);
    id(value.id);
    text(value.label);
    if (value.version !== undefined)
        text(value.version, 80);
    return value;
}
function bindings(input: unknown): TopologyBindings {
    const value = object(input, ['resourceIds', 'componentIds', 'checkIds']);
    ids(value.resourceIds);
    if (value.componentIds !== undefined) {
        ids(value.componentIds);
        if ((value.componentIds as unknown[]).length && !(value.resourceIds as unknown[]).length)
            throw Error('Component observations require their native resource binding');
    }
    if (value.checkIds !== undefined)
        ids(value.checkIds);
    return value as unknown as TopologyBindings;
}
export function readSystemTopologyInput(input: unknown): SystemTopologyInput {
    const value = object(input, ['id', 'label', 'nodes', 'boundaries', 'connections']);
    id(value.id);
    text(value.label);
    const boundaryIds = new Set<string>(), nodeIds = new Set<string>(), edgeIds = new Set<string>();
    for (const raw of list(value.boundaries, 64)) {
        const b = object(raw, ['id', 'label', 'kind', 'parentId', 'technology', 'bindings']);
        const bid = id(b.id);
        if (boundaryIds.has(bid))
            throw Error('Duplicate topology boundary');
        boundaryIds.add(bid);
        text(b.label);
        if (!['host', 'server', 'vm', 'cluster', 'runtime', 'namespace', 'pod', 'container', 'region', 'security', 'group'].includes(String(b.kind)))
            throw Error('Unknown topology boundary');
        if (b.parentId !== undefined)
            id(b.parentId);
        if (b.technology !== undefined)
            technology(b.technology);
        if (b.bindings !== undefined)
            bindings(b.bindings);
    }
    const parents = new Map((value.boundaries as {
        id: string;
        parentId?: string;
    }[]).map(b => [b.id, b.parentId]));
    for (const b of value.boundaries as {
        id: string;
        parentId?: string;
    }[]) {
        const visited = new Set<string>([b.id]);
        let parent = b.parentId;
        while (parent) {
            if (!parents.has(parent) || visited.has(parent))
                throw Error('Invalid or cyclic topology placement');
            visited.add(parent);
            parent = parents.get(parent);
        }
    }
    for (const raw of list(value.nodes, 128)) {
        const n = object(raw, ['id', 'label', 'category', 'origin', 'boundaryId', 'technology', 'description', 'bindings']);
        const nid = id(n.id);
        if (nodeIds.has(nid) || boundaryIds.has(nid))
            throw Error('Duplicate topology node');
        nodeIds.add(nid);
        text(n.label);
        if (!['compute', 'storage', 'network', 'identity', 'other'].includes(String(n.category)) || !['existing', 'deployment', 'embedded'].includes(String(n.origin)))
            throw Error('Declare topology category and origin');
        if (n.boundaryId !== undefined && !boundaryIds.has(id(n.boundaryId)))
            throw Error('Unknown topology placement');
        if (n.technology !== undefined)
            technology(n.technology);
        if (n.description !== undefined)
            text(n.description, 512);
        bindings(n.bindings);
    }
    for (const raw of list(value.connections, 256)) {
        const e = object(raw, ['id', 'from', 'to', 'kind', 'label', 'details', 'checkIds']);
        const eid = id(e.id);
        if (edgeIds.has(eid))
            throw Error('Duplicate topology connection');
        edgeIds.add(eid);
        if (!nodeIds.has(id(e.from)) || !nodeIds.has(id(e.to)) || e.from === e.to || !['communicatesWith', 'dependsOn'].includes(String(e.kind)))
            throw Error('Invalid topology connection');
        communicationFields(e.kind, e.details);
        if (e.label !== undefined)
            text(e.label);
        if (e.checkIds !== undefined)
            ids(e.checkIds);
    }
    return freeze(value as unknown as SystemTopologyInput);
}
/** Browser-safe shape reader. Cryptographic declaration admission is in the node export. */
export function readSystemTopologyDefinition(input: unknown): SystemTopologyDefinition {
    const value = object(input, ['version', 'kind', 'id', 'label', 'binding', 'digest', 'nodes', 'boundaries', 'connections']);
    if (value.version !== 1 || value.kind !== 'system-topology')
        throw Error('Unsupported system topology');
    const binding = object(value.binding, ['targetId', 'graphDigest']);
    id(binding.targetId);
    digest(binding.graphDigest);
    digest(value.digest);
    readSystemTopologyInput({ id: value.id, label: value.label, nodes: value.nodes, boundaries: value.boundaries, connections: value.connections });
    return freeze(value as unknown as SystemTopologyDefinition);
}
function evidence(input: unknown, kind: TopologyEvidenceReference['kind']) {
    const value = object(input, ['kind', 'runId', 'runtimeStageId', 'complete']);
    if (value.kind !== kind || typeof value.complete !== 'boolean')
        throw Error('Invalid topology evidence');
    id(value.runId);
    if (value.runtimeStageId !== undefined)
        text(value.runtimeStageId, 1024);
    return value;
}
export function readSystemTopologyObservations(input: unknown): SystemTopologyObservations {
    const value = object(input, ['targetId', 'graphDigest', 'definitionDigest', 'configurationDigest', 'resources', 'components', 'checks', 'actions']);
    id(value.targetId);
    for (const key of ['graphDigest', 'definitionDigest', 'configurationDigest'])
        digest(value[key]);
    const resources = new Set<string>(), components = new Set<string>(), checks = new Set<string>();
    for (const raw of list(value.resources, 256)) {
        const r = object(raw, ['id', 'status', 'action', 'evidence']);
        const rid = id(r.id);
        if (resources.has(rid) || !['pending', 'deploying', 'ready', 'failed', 'skipped', 'deleted'].includes(String(r.status)))
            throw Error('Invalid topology resource observation');
        resources.add(rid);
        if (r.action !== undefined && !['create', 'update', 'verify', 'delete', 'noop'].includes(String(r.action)))
            throw Error('Invalid topology resource action');
        evidence(r.evidence, 'deployment');
    }
    for (const raw of list(value.components, 256)) {
        const c = object(raw, ['id', 'resourceId', 'phase', 'status', 'installed', 'running', 'evidence']);
        const key = id(c.resourceId) + ':' + id(c.id);
        if (components.has(key) || !['inspect', 'revalidate', 'configure', 'reload', 'start', 'apply', 'observe'].includes(String(c.phase)) || !['running', 'passed', 'failed', 'unknown'].includes(String(c.status)))
            throw Error('Invalid topology component observation');
        components.add(key);
        for (const field of ['installed', 'running'])
            if (c[field] !== undefined && typeof c[field] !== 'boolean')
                throw Error('Invalid measured component fact');
        evidence(c.evidence, 'adapter');
    }
    for (const raw of list(value.checks, 512)) {
        const c = object(raw, ['id', 'status', 'evidence']);
        const cid = id(c.id);
        if (checks.has(cid) || !['checking', 'passed', 'failed', 'unknown'].includes(String(c.status)))
            throw Error('Invalid topology check observation');
        checks.add(cid);
        evidence(c.evidence, 'check');
    }
    if(value.actions!==undefined){
        const actions=new Set<string>();
        for(const raw of list(value.actions,2048)){
            const a=object(raw,['resourceId','componentId','phase','status','evidence']);
            id(a.resourceId);if(a.componentId!==undefined)id(a.componentId);
            if(!['inspect','revalidate','configure','reload','start','apply','observe'].includes(String(a.phase))||!['running','passed','failed','unknown'].includes(String(a.status)))throw Error('Invalid topology action');
            const reference=evidence(a.evidence,'adapter');
            if(reference.runtimeStageId===undefined)throw Error('Topology actions require their native stage');
            const key=[a.resourceId,a.componentId??'',a.phase,reference.runtimeStageId].join('\0');
            if(actions.has(key))throw Error('Duplicate topology action');actions.add(key);
        }
    }
    return freeze(value as unknown as SystemTopologyObservations);
}
