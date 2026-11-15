import { readFlowReceipt, readVerificationResult } from '../resource-flow/data.ts';
import type { FlowReceipt, VerificationResult } from '../resource-flow/types.ts';
import { canonical, fingerprint } from '../util.ts';
import { row, refused, reference } from './data.ts';
import { AGENT_CAPABILITIES, type AgentCapabilityId, type AgentCapabilityObservation, type AgentCapabilityState, type AgentDeployment, type AgentVerificationRequest } from './types.ts';

const factPrefix = 'agent-capability.';
function proof(input: unknown): FlowReceipt {
 const value = readFlowReceipt(input); if (!value.runId && !value.evidencePath) refused();
 if (value.evidencePath) reference(value.evidencePath); return value;
}
/** Admit measured outcomes against the exact operation, revision and physical environment. */
export function admitAgentVerification(input: unknown, expected: AgentVerificationRequest, definition: AgentDeployment): VerificationResult {
 const value = row(input, ['request', 'ok', 'checks', 'receipts', 'capabilities']);
 if (canonical(value.request) !== canonical(expected)) refused();
 const verification = readVerificationResult({ ok: value.ok, checks: value.checks, ...(value.receipts !== undefined ? { receipts: value.receipts } : {}) });
 if (verification.checks.some(check => check.id.startsWith(factPrefix) || check.id.startsWith('agent-required-')) || !Array.isArray(value.capabilities) || value.capabilities.length > definition.capabilityIds.length) refused();
 const measured = new Map<AgentCapabilityId, AgentCapabilityObservation>();
 for (const raw of value.capabilities) {
  const item = row(raw, ['id', 'status', 'proof']);
  if (!definition.capabilityIds.includes(item.id as string) || measured.has(item.id as AgentCapabilityId) || !['supported', 'unsupported', 'unknown'].includes(String(item.status))) refused();
  const observed = { id: item.id as AgentCapabilityId, status: item.status as AgentCapabilityObservation['status'], ...(item.proof !== undefined ? { proof: proof(item.proof) } : {}) };
  if (observed.status === 'supported' && !observed.proof) refused(); measured.set(observed.id, observed);
 }
 const checks = [...verification.checks], receipts = [...verification.receipts ?? []];
 for (const id of definition.requiredCheckIds) checks.push({ id: 'agent-required-check.' + id, passed: verification.checks.some(check => check.id === id && check.passed) });
 for (const id of definition.capabilityIds) {
  const observed = measured.get(id) ?? { id, status: 'unknown' as const }, receiptDigest = observed.proof ? fingerprint(observed.proof) : undefined;
  checks.push({ id: factPrefix + id + '.' + observed.status + (receiptDigest ? '.' + receiptDigest : ''), passed: true });
  if (observed.proof && !receipts.some(receipt => canonical(receipt) === canonical(observed.proof))) receipts.push(observed.proof);
  if (definition.requiredCapabilities.includes(id)) checks.push({ id: 'agent-required-capability.' + id, passed: observed.status === 'supported' && !!observed.proof });
 }
 return readVerificationResult({ ok: checks.every(check => check.passed), checks, ...(receipts.length ? { receipts } : {}) });
}
/** Capability facts are read from native verification data, not a side ledger. */
export function recordedAgentCapabilities(verification?: VerificationResult, capabilityIds: readonly string[] = AGENT_CAPABILITIES): AgentCapabilityState[] {
 return capabilityIds.map(id => {
  const rows = verification?.checks.filter(check => check.id.startsWith(factPrefix + id + '.')) ?? [];
  if (!rows.length) return { id, status: 'unknown', source: 'unmeasured' };
  if (rows.length !== 1 || !rows[0]!.passed) refused();
  const suffix = rows[0]!.id.slice((factPrefix + id + '.').length).split('.'), [status, receiptDigest] = suffix;
  if (suffix.length > 2 || !['supported', 'unsupported', 'unknown'].includes(status!)) refused();
  const receipt = receiptDigest ? verification?.receipts?.find(item => fingerprint(item) === receiptDigest) : undefined;
  if (receiptDigest && (!/^[a-f0-9]{64}$/.test(receiptDigest) || !receipt) || status === 'supported' && !receipt) refused();
  return { id, status: status as AgentCapabilityObservation['status'], source: 'native-verification', ...(receipt ? { proof: proof(receipt) } : {}) };
 });
}
