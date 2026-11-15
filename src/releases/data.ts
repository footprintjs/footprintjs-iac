import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { readDeliveryArtifacts, readSourceRevision } from '../delivery/data.ts';
import type { ReleaseChoice, ReleaseManifest, ResolvedReleaseChoice } from './types.ts';

export function releaseObject(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('Invalid release data');
  return value;
}
export function releaseText(input: unknown, max = 2048): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || /[\x00-\x1f\x7f]|-----BEGIN [^-]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(input)) throw Error('Invalid public release text');
  return input;
}
export function releaseDigest(input: unknown): string {
  const value = releaseText(input,64); if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid release digest'); return value;
}
export function releaseRepository(input: unknown): string {
  const value = releaseText(input);
  if (/^source-sha256:[a-f0-9]{64}$/.test(value)) return value;
  let url: URL; try { url = new URL(value); } catch { throw Error('Release repository must be a public identity, not a host path'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Release repository must be credential-free HTTPS');
  return value;
}
function source(input: unknown, resolved: boolean) {
  const row=releaseObject(input,['repository','ref','commit','tree']);
  const result: ReleaseChoice['source']={repository:releaseRepository(row.repository),ref:releaseText(row.ref,256)};
  for(const key of ['commit','tree'] as const) if(row[key]!==undefined){
    const value=releaseText(row[key],64);if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))throw Error('Invalid source identity');result[key]=value;
  }
  if(resolved && (!result.commit||!result.tree))throw Error('Resolve the exact source commit and tree');
  return result;
}
export function readReleaseChoice(input: unknown): ReleaseChoice {
  const row=releaseObject(input,['id','label','version','source','publishedAt','url','manifestDigest']);
  const result:ReleaseChoice={id:identifier(row.id,'release choice'),label:releaseText(row.label,160),source:source(row.source,false)};
  if(row.version!==undefined)result.version=releaseText(row.version,256);
  if(row.publishedAt!==undefined){const value=releaseText(row.publishedAt,64);if(!Number.isFinite(Date.parse(value)))throw Error('Invalid release date');result.publishedAt=value;}
  if(row.url!==undefined){const value=releaseText(row.url);const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid release URL');result.url=value;}
  if(row.manifestDigest!==undefined)result.manifestDigest=releaseDigest(row.manifestDigest);
  return freeze(result);
}
export function readResolvedReleaseChoice(input: unknown): ResolvedReleaseChoice {
  const result=readReleaseChoice(input);source(result.source,true);return result as ResolvedReleaseChoice;
}
export function readPublicReleaseArtifacts(input:unknown){
  const artifacts=readDeliveryArtifacts(input);
  for(const artifact of artifacts)if(/^(?:\/|[A-Za-z]:[\\/]|\.{1,2}[\\/]|~\/)|^file:/i.test(artifact.reference))throw Error('Public artifact references cannot expose host paths');
  return artifacts;
}
/** Browser-safe structural admission. Hosts verify the digest using /releases/node before effects. */
export function readReleaseManifestShape(input: unknown): ReleaseManifest {
  const row=releaseObject(input,['kind','schemaVersion','id','label','source','recipe','artifacts','digest']);
  if(row.kind!=='release-manifest'||row.schemaVersion!==1)throw Error('Unsupported release manifest');
  const revision=readSourceRevision(source(row.source,true));
  const recipe=releaseObject(row.recipe,['id','digest']);
  const result:ReleaseManifest={kind:'release-manifest',schemaVersion:1,id:identifier(row.id,'release manifest'),
    source:revision,recipe:{id:identifier(recipe.id,'release recipe'),digest:releaseDigest(recipe.digest)},
    artifacts:readPublicReleaseArtifacts(row.artifacts),digest:releaseDigest(row.digest),
    ...(row.label!==undefined?{label:releaseText(row.label,160)}:{})};
  return freeze(result);
}
