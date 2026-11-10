import { freeze, identifier, keys } from '../graph/data.ts';
import { exactValue, exactValues, plainRecord } from './values.ts';
import type { AccessObservation, IdentityCheckRequest, IdentityObservationCode, IdentityObservationDetails } from './types.ts';

const codes: readonly IdentityObservationCode[] = ['verified', 'invalid-credentials', 'anonymous', 'access-allowed', 'access-denied',
  'directory-unavailable', 'identity-unavailable', 'transport-failure', 'tls-error', 'connection-refused', 'provider-unavailable',
  'backend-error', 'invalid-observation', 'adapter-failure'];
export function readIdentityCheck(input: unknown): IdentityCheckRequest {
  const row = plainRecord(input, 'identity check'); keys(row, ['id', 'label', 'kind', 'expected'], 'identity check');
  const id = identifier(row.id, 'identity check id');
  const label = exactValue(row.label, 'identity check label');
  if (!['login', 'access', 'directory'].includes(String(row.kind))) throw new Error('Invalid identity check kind');
  const acceptable = row.kind === 'login' ? ['authenticated', 'rejected'] : row.kind === 'access' ? ['allowed', 'denied'] : ['available'];
  if (!acceptable.includes(String(row.expected))) throw new Error('Identity expected verdict does not match its check kind');
  return freeze({ id, label, kind: row.kind, expected: row.expected } as IdentityCheckRequest);
}

function readDetails(input: unknown): IdentityObservationDetails {
  const row = plainRecord(input, 'identity observation details');
  keys(row, ['code', 'httpStatus', 'sourceId', 'subjectId', 'policyId', 'matchedRuleIds', 'action', 'resource', 'protocol', 'phase'], 'identity observation details');
  if (row.code !== undefined && !codes.includes(row.code as IdentityObservationCode)) throw new Error('Unknown identity observation code');
  if (row.httpStatus !== undefined && (!Number.isInteger(row.httpStatus) || (row.httpStatus as number) < 100 || (row.httpStatus as number) > 599)) throw new Error('Invalid identity HTTP status');
  for (const key of ['sourceId', 'policyId']) if (row[key] !== undefined) identifier(row[key], 'identity ' + key);
  for (const key of ['subjectId', 'action', 'resource']) if (row[key] !== undefined) exactValue(row[key], 'identity ' + key);
  if (row.matchedRuleIds !== undefined) for (const id of exactValues(row.matchedRuleIds, 'matched rule ids', true)) identifier(id, 'matched rule id');
  if (row.protocol !== undefined && !['ldap', 'ldaps', 'oidc', 'http', 'https'].includes(String(row.protocol))) throw new Error('Invalid identity protocol');
  if (row.phase !== undefined && !['directory', 'authentication', 'authorization', 'transport'].includes(String(row.phase))) throw new Error('Invalid identity phase');
  return row as unknown as IdentityObservationDetails;
}
/** Unknown fields are refused instead of persisting raw adapter responses. */
export function readAccessObservation(input: unknown): AccessObservation {
  const row = plainRecord(input, 'identity observation');
  keys(row, ['verdict', 'observedAt', 'latencyMs', 'details'], 'identity observation');
  if (!['authenticated', 'rejected', 'allowed', 'denied', 'available', 'unavailable'].includes(String(row.verdict))
    || typeof row.observedAt !== 'number' || !Number.isFinite(row.observedAt) || row.observedAt < 0
    || typeof row.latencyMs !== 'number' || !Number.isFinite(row.latencyMs) || row.latencyMs < 0) throw new Error('Invalid identity observation');
  return freeze({ verdict: row.verdict, observedAt: row.observedAt, latencyMs: row.latencyMs,
    ...(row.details === undefined ? {} : { details: readDetails(row.details) }) } as AccessObservation);
}
