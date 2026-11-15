import { freeze } from '../graph/data.ts';
import { canonical, fingerprint } from '../util.ts';
import { readReleaseManifestShape, releaseObject } from './data.ts';
import type { ReleaseManifest, ReleaseManifestInput } from './types.ts';
import { publicSourceRepository } from '../delivery/source-identity.ts';

function body(input: ReleaseManifestInput) {
  const safe=releaseObject(input,['id','label','source','recipe','artifacts']) as unknown as ReleaseManifestInput;
  if(typeof safe.source?.repository!=='string')throw Error('Invalid release source');
  const repository=publicSourceRepository(safe.source.repository);
  const shaped=readReleaseManifestShape({...safe,kind:'release-manifest',schemaVersion:1,
    source:{...safe.source,repository},digest:'0'.repeat(64)});
  const {digest:_,...result}=shaped;
  return {...result,artifacts:[...result.artifacts].sort((a,b)=>a.id.localeCompare(b.id))};
}
export function defineReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const value=body(input);return freeze({...value,digest:fingerprint(value)});
}
/** Full host admission binds every artifact, source identity and build recipe to the digest. */
export function readReleaseManifest(input: unknown): ReleaseManifest {
  const shaped=readReleaseManifestShape(input),{digest,kind:_,schemaVersion:__,...value}=shaped;
  const normalized=body(value);
  if(fingerprint(normalized)!==digest)throw Error('Release manifest digest changed');
  return freeze({...normalized,digest});
}
export function sameRelease(left: ReleaseManifest,right:ReleaseManifest):boolean{
  return canonical(readReleaseManifest(left))===canonical(readReleaseManifest(right));
}
