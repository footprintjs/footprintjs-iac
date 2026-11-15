import {fingerprint} from '../util.ts';
import type {ResolvedReleaseChoice} from '../releases/types.ts';
/** A second tag for the same repository content cannot silently rebuild/redeploy it. */
export function releaseSourceDigest(source:ResolvedReleaseChoice['source']){return fingerprint({repository:source.repository,commit:source.commit,tree:source.tree});}
