import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { CHECK_STATUSES, type CheckRequest, type CheckResult, type CheckStatus, type CheckSuite } from './types.ts';

function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Invalid check data');
  return value;
}
function text(input: unknown, maximum = 256): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\x00-\x1f\x7f]/.test(input)) throw Error('Invalid check text');
  return input;
}
function digest(input: unknown): string { const value = text(input, 71); if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) throw Error('Invalid check digest'); return value; }
function status(input: unknown): CheckStatus { if (!CHECK_STATUSES.includes(input as CheckStatus)) throw Error('Invalid check status'); return input as CheckStatus; }
export function readCheckSuite(input: unknown): CheckSuite {
  const value = object(input, ['id','label','digest','kind']);
  identifier(value.id, 'check suite'); text(value.label,160); digest(value.digest); identifier(value.kind,'check kind');
  return freeze(value as unknown as CheckSuite);
}
export function readCheckRequest(input: unknown): CheckRequest {
  const value = object(input,['invocationId','suiteId','suiteDigest','releaseId','releaseDigest','stageId','target','reason']);
  for (const key of ['invocationId','suiteId','releaseId','stageId']) identifier(value[key],key);
  digest(value.suiteDigest); digest(value.releaseDigest);
  const target = object(value.target,['id','scope']); identifier(target.id,'check target'); text(target.scope,4096);
  if (!['after-deploy','rollout-analysis','recovery','scheduled','manual'].includes(String(value.reason))) throw Error('Invalid check reason');
  return freeze(value as unknown as CheckRequest);
}
export function checkStatus(checks: readonly { status: CheckStatus }[]): CheckStatus {
  if (!checks.length || checks.some(check => check.status === 'error')) return 'error';
  if (checks.some(check => check.status === 'failed')) return 'failed';
  if (checks.some(check => check.status === 'inconclusive')) return 'inconclusive';
  if (checks.some(check => check.status === 'skipped')) return 'skipped';
  return 'passed';
}
export function readCheckResult(input: unknown): CheckResult {
  const value = object(input,['request','status','checks','artifacts','receipt']); readCheckRequest(value.request); status(value.status);
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 4096) throw Error('Bound check results');
  const ids = new Set<string>();
  for (const item of value.checks) {
    const check = object(item,['id','status','statusCode','durationMs']), id = identifier(check.id,'check result');
    if (ids.has(id)) throw Error('Duplicate check result'); ids.add(id); status(check.status);
    if (check.statusCode !== undefined && (!Number.isInteger(check.statusCode) || Number(check.statusCode) < 100 || Number(check.statusCode) > 599)) throw Error('Invalid HTTP result');
    if (check.durationMs !== undefined && (!Number.isFinite(check.durationMs) || Number(check.durationMs) < 0)) throw Error('Invalid check duration');
  }
  if (value.status !== checkStatus(value.checks as unknown as {status: CheckStatus}[])) throw Error('Check aggregate differs from observations');
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 128) throw Error('Bound check artifacts');
    const artifactIds = new Set<string>();
    for (const item of value.artifacts) {
      const artifact = object(item,['id','digest','reference']), id = identifier(artifact.id,'check artifact');
      if (artifactIds.has(id)) throw Error('Duplicate check artifact'); artifactIds.add(id); digest(artifact.digest);
      const reference = text(artifact.reference,4096);
      if (/^[\/\\]|^[A-Za-z]:[\/\\]|[?#]|^[^/]*:[^/]*@|(?:^|[\/\\])\.\.(?:[\/\\]|$)|^(?:file|javascript|data|vbscript):|-----BEGIN|\bgh[pousr]_[A-Za-z0-9]{20,}/i.test(reference)) throw Error('Use a public non-secret artifact reference');
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) { const url = new URL(reference); if (url.username || url.password || url.search || url.hash || url.protocol === 'file:') throw Error('Use a non-secret artifact reference'); }
    }
  }
  if (value.receipt !== undefined) {
    const receipt = object(value.receipt,['runId','evidencePath','tracePath']);
    if (receipt.runId !== undefined) identifier(receipt.runId,'check receipt run');
    for (const key of ['evidencePath','tracePath']) if (receipt[key] !== undefined) text(receipt[key],4096);
  }
  return freeze(value as unknown as CheckResult);
}
export function readCheckCatalog(input: readonly CheckSuite[]): readonly CheckSuite[] {
  if (!Array.isArray(input) || !input.length || input.length > 128) throw Error('Configure a bounded check catalog');
  const suites = input.map(readCheckSuite);
  if (new Set(suites.map(suite => suite.id)).size !== suites.length) throw Error('Duplicate configured check suite');
  return Object.freeze(suites);
}
