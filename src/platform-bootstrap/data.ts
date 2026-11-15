import { isIP } from 'node:net';
import { freeze, jsonCopy, identifier as resourceIdentifier } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { readResourceHandle, readFlowReceipt } from '../resource-flow/data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import type { BootstrapAction, BootstrapActionReceipt, BootstrapContext, BootstrapIntent, BootstrapPlan, BootstrapRevalidation, ClusterObservation, HostPreparationAssessment, PublishedClusterAccess } from './types.ts';

function invalid(): never { throw new ClusterBootstrapAdapterError('invalid-bootstrap-contract'); }
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) invalid();
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
const semverNumber = '(?:0|[1-9][0-9]*)';
const semverPrerelease = `(?:${semverNumber}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const platformVersionPattern = new RegExp(`^v?${semverNumber}\\.${semverNumber}\\.${semverNumber}(?:-${semverPrerelease}(?:\\.${semverPrerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export function version(value: unknown): string {
  const normalized = normalizedPlatformVersion(value);
  if (normalized === undefined) invalid();
  return normalized;
}
/** Generic contract preserves prerelease/build identity; concrete providers impose their own compatibility rules. */
export function normalizedPlatformVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128 && platformVersionPattern.test(value) ? value.replace(/^v/, '') : undefined;
}
function cidr(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80) invalid();
  const parts = value.split('/'), family = isIP(parts[0] ?? '');
  if (parts.length !== 2 || !family || !/^(?:0|[1-9][0-9]*)$/.test(parts[1] ?? '')
    || Number(parts[1]) > (family === 4 ? 32 : 128)) invalid();
  return value;
}
export function readBootstrapIntent(input: unknown): BootstrapIntent {
  const value = object(jsonCopy(input), ['id', 'mode', 'topology']);
  if (value.mode !== 'create' && value.mode !== 'existing') invalid();
  const topology = object(value.topology, ['version', 'nodes', 'podNetworkCidr', 'serviceNetworkCidr']);
  if (!Array.isArray(topology.nodes) || (value.mode === 'create' && !topology.nodes.length) || topology.nodes.length > 128) invalid();
  const nodes = topology.nodes.map(value => {
    const node = object(value, ['hostId', 'role']);
    if (node.role !== 'control-plane' && node.role !== 'worker') invalid();
    return { hostId: identifier(node.hostId), role: node.role as 'control-plane' | 'worker' };
  });
  if (new Set(nodes.map(node => node.hostId)).size !== nodes.length || (value.mode === 'create' && !nodes.some(node => node.role === 'control-plane'))) invalid();
  return freeze({ id: resourceIdentifier(value.id, 'cluster resource'), mode: value.mode,
    topology: { version: version(topology.version), nodes,
      ...(topology.podNetworkCidr !== undefined ? { podNetworkCidr: cidr(topology.podNetworkCidr) } : {}),
      ...(topology.serviceNetworkCidr !== undefined ? { serviceNetworkCidr: cidr(topology.serviceNetworkCidr) } : {}) } });
}
export function readBootstrapContext(input: unknown): BootstrapContext {
  const value = object(jsonCopy(input), ['executionId', 'operationId', 'completedActionIds', 'resource']);
  if (!Array.isArray(value.completedActionIds) || value.completedActionIds.length > 512) invalid();
  const completedActionIds = value.completedActionIds.map(identifier);
  if (new Set(completedActionIds).size !== completedActionIds.length) invalid();
  return freeze({ executionId: identifier(value.executionId), operationId: identifier(value.operationId), completedActionIds,
    ...(value.resource !== undefined ? { resource: readResourceHandle(value.resource) } : {}) });
}
export function readBootstrapAction(input: unknown): BootstrapAction {
  const value = object(jsonCopy(input), ['id', 'hostId', 'phase', 'actionDigest']);
  if (!['prepare', 'initialize', 'network', 'join'].includes(String(value.phase))) invalid();
  return { id: identifier(value.id), hostId: identifier(value.hostId), phase: value.phase as BootstrapAction['phase'], actionDigest: digest(value.actionDigest) };
}
export function bootstrapPlanDigest(plan: Omit<BootstrapPlan, 'digest'> | BootstrapPlan): string {
  const { observationsDigest: _observations, preparations: _preparations, digest: _digest, existingResource, ...semantic } = plan as BootstrapPlan;
  const identity = existingResource ? { id: existingResource.id, kind: existingResource.kind, physicalId: existingResource.physicalId, scope: existingResource.scope } : undefined;
  return fingerprint({ ...semantic, ...(identity ? { existingResource: identity } : {}) });
}
export function sealBootstrapPlan(input: Omit<BootstrapPlan, 'digest'>): BootstrapPlan {
  return readBootstrapPlan({ ...input, digest: bootstrapPlanDigest(input) });
}
export function readBootstrapPlan(input: unknown): BootstrapPlan {
  const value = object(jsonCopy(input), ['kind', 'version', 'adapterId', 'scope', 'mode', 'intentDigest', 'configurationDigest', 'strategy',
    'hostIdentities', 'existingResource', 'observationsDigest', 'preparations', 'disposition', 'reasons', 'actions', 'digest']);
  if (value.kind !== 'cluster-bootstrap-plan' || value.version !== 1 || !['create', 'existing'].includes(String(value.mode))
    || !['create', 'connect', 'blocked'].includes(String(value.disposition)) || !Array.isArray(value.hostIdentities)
    || !Array.isArray(value.reasons) || value.reasons.length > 512 || !Array.isArray(value.actions) || value.actions.length > 512) invalid();
  const strategy = object(value.strategy, ['id', 'digest']);
  const result: BootstrapPlan = { kind: 'cluster-bootstrap-plan', version: 1, adapterId: identifier(value.adapterId), scope: identifier(value.scope),
    mode: value.mode as BootstrapPlan['mode'], intentDigest: digest(value.intentDigest), configurationDigest: digest(value.configurationDigest),
    strategy: { id: identifier(strategy.id), digest: digest(strategy.digest) },
    hostIdentities: value.hostIdentities.map(value => { const identity = object(value, ['hostId', 'identityDigest']);
      return { hostId: identifier(identity.hostId), identityDigest: digest(identity.identityDigest) }; }),
    ...(value.existingResource !== undefined ? { existingResource: readResourceHandle(value.existingResource) } : {}),
    observationsDigest: digest(value.observationsDigest), ...(value.preparations !== undefined ? { preparations: readPreparations(value.preparations) } : {}),
    disposition: value.disposition as BootstrapPlan['disposition'], reasons: value.reasons.map(identifier),
    actions: value.actions.map(readBootstrapAction), digest: digest(value.digest) };
  if (new Set(result.hostIdentities.map(item => item.hostId)).size !== result.hostIdentities.length || new Set(result.actions.map(item => item.id)).size !== result.actions.length
    || result.digest !== bootstrapPlanDigest(result) || (result.disposition !== 'create' && result.actions.length)) invalid();
  return freeze(result);
}
export function readClusterObservation(input: unknown): ClusterObservation {
  const value = object(jsonCopy(input), ['status', 'resource', 'platformVersion']);
  if (!['present', 'absent', 'unknown'].includes(String(value.status)) || (value.status === 'present') !== (value.resource !== undefined)) invalid();
  if (value.platformVersion !== undefined && (value.status !== 'present' || typeof value.platformVersion !== 'string'
    || !/^[vV0-9A-Za-z.+_-]{1,128}$/.test(value.platformVersion))) invalid();
  return freeze({ status: value.status as ClusterObservation['status'], ...(value.resource !== undefined ? { resource: readResourceHandle(value.resource) } : {}),
    ...(value.platformVersion !== undefined ? { platformVersion: value.platformVersion as string } : {}) });
}
export function readBootstrapRevalidation(input: unknown): BootstrapRevalidation {
  const value = object(jsonCopy(input), ['valid', 'planDigest', 'observationsDigest', 'reasons', 'preparations']);
  if (typeof value.valid !== 'boolean' || !Array.isArray(value.reasons) || value.reasons.length > 512) invalid();
  return freeze({ valid: value.valid, planDigest: digest(value.planDigest), observationsDigest: digest(value.observationsDigest), reasons: value.reasons.map(identifier),
    ...(value.preparations !== undefined ? { preparations: readPreparations(value.preparations) } : {}) });
}
export function readBootstrapActionReceipt(input: unknown): BootstrapActionReceipt {
  const value = object(jsonCopy(input), ['id', 'actionId', 'hostId', 'status', 'receipt', 'resource']);
  if (value.status !== 'completed') invalid();
  return freeze({ id: identifier(value.id), actionId: identifier(value.actionId), hostId: identifier(value.hostId), status: 'completed',
    receipt: readFlowReceipt(value.receipt), ...(value.resource !== undefined ? { resource: readResourceHandle(value.resource) } : {}) });
}
export function readPublishedClusterAccess(input: unknown): PublishedClusterAccess | undefined {
  if (input === undefined) return undefined;
  const value = object(jsonCopy(input), ['profileId', 'receipt']);
  return freeze({ profileId: resourceIdentifier(value.profileId, 'cluster access profile'), ...(value.receipt !== undefined ? { receipt: readFlowReceipt(value.receipt) } : {}) });
}
export function preparationAssessmentDigest(input: Omit<HostPreparationAssessment, 'digest'> | HostPreparationAssessment): string {
  const { digest: _digest, ...value } = input as HostPreparationAssessment;
  return fingerprint(value);
}
export function readHostPreparationAssessment(input: unknown): HostPreparationAssessment {
  const value = object(jsonCopy(input), ['hostId', 'identityDigest', 'recipeDigest', 'status', 'actions', 'checks', 'observedAt', 'digest']);
  if (!['ready', 'preparable', 'blocked', 'unknown'].includes(String(value.status)) || !Array.isArray(value.actions) || value.actions.length > 64
    || !Array.isArray(value.checks) || value.checks.length > 64 || !Number.isSafeInteger(value.observedAt) || (value.observedAt as number) <= 0) invalid();
  const result: HostPreparationAssessment = { hostId: identifier(value.hostId), identityDigest: digest(value.identityDigest), recipeDigest: digest(value.recipeDigest),
    status: value.status as HostPreparationAssessment['status'], actions: value.actions.map(readBootstrapAction),
    checks: value.checks.map(value => { const check = object(value, ['id', 'passed']); if (typeof check.passed !== 'boolean') invalid();
      return { id: identifier(check.id), passed: check.passed }; }), observedAt: value.observedAt as number, digest: digest(value.digest) };
  if (result.actions.some(action => action.hostId !== result.hostId || action.phase !== 'prepare') || new Set(result.checks.map(check => check.id)).size !== result.checks.length
    || new Set(result.actions.map(action => action.id)).size !== result.actions.length || result.digest !== preparationAssessmentDigest(result)) invalid();
  return freeze(result);
}
function readPreparations(input: unknown): HostPreparationAssessment[] {
  if (!Array.isArray(input) || input.length > 128) invalid();
  const values = input.map(readHostPreparationAssessment);
  if (new Set(values.map(value => value.hostId)).size !== values.length) invalid();
  return values;
}
