/** Provider-free composition root. Import a selected provider from its optional subpath. */
export { InfraEngine, type ApplyResult } from './engine.ts';
export { FileStateStore } from './store.ts';
export { ReconcileStrategy } from './strategies.ts';
export { buildPlan, orderResources } from './planner.ts';
export { canonical, fingerprint, project } from './util.ts';
export { ProviderChangeError } from './resource-change.ts';
export { resourceAttribute } from './resource-attributes.ts';
export { replay, backwalk, loadEvidence, verifyEvidenceTrace, type RunEvidence, type EvidenceTraceInput } from './evidence.ts';
export type * from './types.ts';
export { DeploymentStrategyRegistry } from './deployment-strategy/registry.ts';
