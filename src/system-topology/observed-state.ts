import type { SystemTopologyObservations, TopologyBindings, TopologyCheckObservation, TopologyComponentObservation, TopologyEvidenceReference, TopologyFact, TopologyResourceObservation, TopologyStatus, } from './types.ts';
export const isReady = (status: string) => status === 'ready' || status === 'connected';
export const terminalUnadmitted = (row: {
    status: string;
    evidence: TopologyEvidenceReference;
}) => !row.evidence.complete && !['pending', 'deploying', 'running', 'checking', 'unknown'].includes(row.status);
export function references(rows: readonly {
    evidence: TopologyEvidenceReference;
}[]) {
    const found = new Map<string, TopologyEvidenceReference>();
    for (const { evidence } of rows) {
        found.set([evidence.kind, evidence.runId, evidence.runtimeStageId, evidence.complete].join(':'), evidence);
    }
    return [...found.values()];
}
export function measuredFact(ids: readonly string[], rows: readonly TopologyComponentObservation[], key: 'installed' | 'running'): TopologyFact {
    if (!coversComponents(ids, rows) || rows.some(row => !row.evidence.complete || row.phase !== 'observe' || row.status !== 'passed' || row[key] === undefined))
        return 'unknown';
    return rows.some(row => row[key] === false) ? 'refuted' : 'confirmed';
}
export function selected(binding: TopologyBindings, observations: SystemTopologyObservations) {
    return {
        resources: observations.resources.filter(row => binding.resourceIds.includes(row.id)),
        components: observations.components.filter(row => binding.resourceIds.includes(row.resourceId) && (binding.componentIds ?? []).includes(row.id)),
        checks: observations.checks.filter(row => (binding.checkIds ?? []).includes(row.id)),
    };
}
export function checkState(ids: readonly string[], rows: readonly TopologyCheckObservation[]): TopologyStatus | undefined {
    if (!ids.length)
        return;
    if (rows.some(terminalUnadmitted))
        return 'incomplete';
    if (rows.some(row => row.status === 'failed'))
        return 'failed';
    if (rows.some(row => row.status === 'checking'))
        return 'checking';
    if (rows.some(row => row.status === 'unknown'))
        return 'unknown';
    if (rows.length !== ids.length)
        return rows.length ? 'unknown' : 'pending';
    return 'ready';
}
export function componentState(ids: readonly string[], rows: readonly TopologyComponentObservation[]): TopologyStatus | undefined {
    if (!ids.length)
        return;
    if (rows.some(terminalUnadmitted))
        return 'incomplete';
    if (rows.some(row => row.status === 'failed' || row.phase === 'observe' && row.status === 'passed' && row.running === false))
        return 'failed';
    if (rows.some(row => row.status === 'unknown'))
        return 'unknown';
    if (rows.some(row => row.status === 'running'))
        return rows.some(row => row.phase === 'start') ? 'starting' : 'checking';
    if (!coversComponents(ids, rows))
        return rows.length ? 'unknown' : 'pending';
    return rows.every(componentReady) ? 'ready' : 'unknown';
}
function coversComponents(ids: readonly string[], rows: readonly TopologyComponentObservation[]) {
    return ids.length > 0 && rows.length === ids.length && ids.every(id => rows.filter(row => row.id === id).length === 1);
}

export function componentReady(row: TopologyComponentObservation) {
    return row.evidence.complete && row.phase === 'observe' && row.status === 'passed' && row.installed === true && row.running === true;
}
export function resourceState(ids: readonly string[], rows: readonly TopologyResourceObservation[]): TopologyStatus | undefined {
    if (!ids.length || !rows.length)
        return;
    if (rows.some(terminalUnadmitted))
        return 'incomplete';
    if (rows.some(row => row.status === 'failed'))
        return 'failed';
    if (rows.some(row => row.status === 'deleted'))
        return 'removed';
    if (rows.some(row => row.status === 'skipped'))
        return 'skipped';
    if (rows.some(row => row.status === 'deploying'))
        return 'checking';
    if (rows.length !== ids.length)
        return 'unknown';
    return rows.every(row => row.status === 'ready') ? 'ready' : 'pending';
}
export function progress(binding: TopologyBindings, rows: ReturnType<typeof selected>) {
    const expected = (binding.componentIds?.length ?? 0) + (binding.checkIds?.length ?? 0);
    const total = expected || binding.resourceIds.length;
    const measured = expected ? [...rows.components, ...rows.checks] : rows.resources;
    const completed = expected
        ? (binding.componentIds ?? []).filter(id => { const matched = rows.components.filter(row => row.id === id); return matched.length === 1 && componentReady(matched[0]!); }).length + rows.checks.filter(row => row.evidence.complete && row.status === 'passed').length
        : rows.resources.filter(row => row.evidence.complete && row.status === 'ready').length;
    return { total, completed, indeterminate: total === 0 || measured.some(row => !row.evidence.complete || row.status === 'unknown') };
}
export function aggregate(statuses: readonly TopologyStatus[]): TopologyStatus {
    if (!statuses.length)
        return 'pending';
    for (const status of ['incomplete', 'failed', 'starting', 'installing', 'checking', 'unknown', 'removed', 'skipped'] as const) {
        if (statuses.includes(status))
            return status;
    }
    return statuses.every(isReady) ? 'ready' : 'pending';
}
