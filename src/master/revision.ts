import { array, freeze, identifier, jsonCopy, keys, object, text } from '../graph/data.ts';
import { validateInfraGraph } from '../graph/validation.ts';
import { fingerprint } from '../util.ts';
import type { MasterArtifact, MasterSource, MasterTarget, RevisionInput, SystemRevision } from './types.ts';

export function digestValue(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error(`Invalid ${where}`);
  return value;
}
export function optionalDigest(value: unknown, where: string): string | null {
  return value === null ? null : digestValue(value, where);
}
function publicText(value: unknown, where: string, limit = 2048): string {
  const result = text(value, where);
  if (!result || result.length > limit || /[\x00-\x1f\x7f]|-----BEGIN [^-]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(result)) throw Error(`Invalid ${where}`);
  return result;
}
export function readMasterTarget(input: unknown): MasterTarget {
  const row = object(jsonCopy(input), 'master target'); keys(row, ['id', 'scope'], 'master target');
  return freeze({ id: identifier(row.id, 'master target id'), scope: publicText(row.scope, 'master target scope', 4096) });
}
function readSource(input: unknown): MasterSource {
  const row = object(jsonCopy(input), 'master source'); keys(row, ['repository', 'commit', 'tree'], 'master source');
  let repository: string | undefined;
  if (row.repository !== undefined) {
    repository = publicText(row.repository, 'source repository');
    if(!/^source-sha256:[a-f0-9]{64}$/.test(repository)){
      const url = new URL(repository);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Repository must be a credential-free HTTP(S) URL or opaque local source identity');
    }
  }
  const hash = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw Error('Invalid source identity'); return value; };
  return { ...(repository === undefined ? {} : { repository }), ...(row.commit === undefined ? {} : { commit: hash(row.commit) }),
    ...(row.tree === undefined ? {} : { tree: hash(row.tree) }) };
}
function readArtifacts(input: unknown): MasterArtifact[] {
  const ids = new Set<string>();
  return array(jsonCopy(input), 'master artifacts').map(value => {
    const row = object(value, 'master artifact'); keys(row, ['id', 'digest', 'reference'], 'master artifact');
    const id = identifier(row.id, 'artifact id'); if (ids.has(id)) throw Error('Duplicate master artifact'); ids.add(id);
    const reference = row.reference === undefined ? undefined : publicText(row.reference, 'artifact reference');
    if (reference && (/[?&#@\s]/.test(reference.replace(/@sha256:[a-f0-9]{64}$/, '')) || /:\/\/[^/]*@/.test(reference))) throw Error('Artifact references must not contain credentials or query parameters');
    return { id, digest: digestValue(row.digest, 'artifact digest'), ...(reference === undefined ? {} : { reference }) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function body(input: unknown): Omit<SystemRevision, 'digest'> {
  const row = object(jsonCopy(input), 'system revision');
  keys(row, ['kind', 'schemaVersion', 'revisionId', 'parentDigest', 'target', 'graph', 'source', 'artifacts', 'digest'], 'system revision');
  if (row.kind !== 'system-revision' || row.schemaVersion !== 1) throw Error('Unsupported system revision kind/schemaVersion');
  return { kind: 'system-revision', schemaVersion: 1, revisionId: identifier(row.revisionId, 'system revision id'),
    parentDigest: optionalDigest(row.parentDigest, 'parent digest'), target: readMasterTarget(row.target), graph: validateInfraGraph(row.graph),
    ...(row.source === undefined ? {} : { source: readSource(row.source) }),
    ...(row.artifacts === undefined ? {} : { artifacts: readArtifacts(row.artifacts) }) };
}
/** A release revision is distinct from the JSON schema and the native deployment run. */
export function defineSystemRevision(input: RevisionInput): SystemRevision {
  const row = object(jsonCopy(input), 'system revision input');
  keys(row, ['revisionId', 'parentDigest', 'target', 'graph', 'source', 'artifacts'], 'system revision input');
  const value = body({ ...row, kind: 'system-revision', schemaVersion: 1 });
  return freeze({ ...value, digest: fingerprint(value) });
}
export function readSystemRevision(input: unknown): SystemRevision {
  const value = body(input), saved = object(jsonCopy(input), 'system revision');
  if (fingerprint(value) !== digestValue(saved.digest, 'system revision digest')) throw Error('System revision digest mismatch');
  return freeze({ ...value, digest: String(saved.digest) });
}
