import { projectNodeActions } from './actions.ts';
import { checkState, componentState, measuredFact, progress, references, resourceState, selected, terminalUnadmitted } from './observed-state.ts';
import type { SystemTopologyObservations, TopologyFact, TopologyNode, TopologyNodeView, TopologyStatus } from './types.ts';
const labels: Record<TopologyStatus, string> = {
    pending: 'Waiting', installing: 'Installing', starting: 'Starting', checking: 'Checking',
    connected: 'Connected', ready: 'Ready', failed: 'Needs attention', unknown: 'Not verified',
    incomplete: 'Recording incomplete', skipped: 'Skipped', removed: 'Removed',
};
export function projectNode(node: TopologyNode, observations: SystemTopologyObservations): TopologyNodeView {
    const rows = selected(node.bindings, observations);
    const all = [...rows.resources, ...rows.components, ...rows.checks];
    const components = componentState(node.bindings.componentIds ?? [], rows.components);
    const checks = checkState(node.bindings.checkIds ?? [], rows.checks);
    const resource = resourceState(node.bindings.resourceIds, rows.resources);
    const hasComponent = !!node.bindings.componentIds?.length;
    const hasChecks = !!node.bindings.checkIds?.length;
    const scope: TopologyNodeView['evidenceScope'] = rows.components.length ? 'component' : rows.checks.length ? 'checks' : rows.resources.length ? 'shared-resource' : 'none';
    let status: TopologyStatus = 'pending';
    if (all.some(terminalUnadmitted))
        status = 'incomplete';
    else if ([components, checks, resource].includes('failed'))
        status = 'failed';
    else if ([components, checks, resource].includes('removed'))
        status = 'removed';
    else if ([components, checks, resource].includes('skipped'))
        status = 'skipped';
    else if (components === 'starting')
        status = 'starting';
    else if (components === 'checking' || checks === 'checking' || resource === 'checking')
        status = 'checking';
    else if (hasComponent) {
        status = components === 'ready' ? (hasChecks && checks !== 'ready' ? 'unknown' : 'ready') : components ?? 'pending';
        if (resource === 'ready' && components === 'pending')
            status = 'unknown';
    }
    else if (hasChecks)
        status = checks === 'ready' ? (node.origin === 'existing' ? 'connected' : 'ready') : checks ?? 'pending';
    else if (node.origin === 'embedded')
        status = resource === 'ready' ? 'unknown' : resource ?? 'pending';
    else
        status = resource ?? 'pending';
    let statusLabel = labels[status];
    const limitations: string[] = [];
    if (scope === 'shared-resource') {
        limitations.push('Only shared resource evidence is available; individual installed and running facts are not established.');
        if (status === 'ready')
            statusLabel = 'Resource ready';
        if (status === 'checking')
            statusLabel = 'Group updating';
        if (status === 'failed')
            statusLabel = 'Group needs attention';
    }
    if (hasComponent && rows.components.length < (node.bindings.componentIds?.length ?? 0) && resource === 'ready') {
        limitations.push('The service group is ready; this component has no independently admitted unit observation.');
        statusLabel = 'Component not verified';
    }
    if (node.origin === 'embedded' && !hasChecks && !hasComponent) {
        limitations.push('Embedded behavior has no independent check; runtime readiness alone does not verify this feature.');
    }
    const installed = measuredFact(node.bindings.componentIds ?? [], rows.components, 'installed');
    const running = measuredFact(node.bindings.componentIds ?? [], rows.components, 'running');
    const created = node.origin === 'deployment' && rows.resources.length === node.bindings.resourceIds.length && rows.resources.length > 0
        && rows.resources.every(row => row.status === 'ready' && row.action === 'create' && row.evidence.complete)
        && (!hasComponent || installed === 'confirmed');
    const originLabel = node.origin === 'existing' ? 'Existing' : node.origin === 'embedded' ? 'Embedded in app' : created ? 'Installed by deployment' : 'Managed by deployment';
    const connected: TopologyFact = hasChecks ? (checks === 'ready' ? 'confirmed' : checks === 'failed' ? 'refuted' : 'unknown') : 'unknown';
    return { ...node, ...(observations.actions===undefined?{}:{actions:projectNodeActions(node,observations.actions)}), status, statusLabel, originLabel, facts: { installed, running, connected }, evidenceScope: scope,
        progress: progress(node.bindings, rows), evidence: references(all), limitations };
}
