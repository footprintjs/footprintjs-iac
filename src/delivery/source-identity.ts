import { fingerprint } from '../util.ts';

/** Stable public identity for a host-approved source; local paths never enter native evidence. */
export function publicSourceRepository(repository:string):string{
  return /^source-sha256:[a-f0-9]{64}$/.test(repository)||/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)&&!/^file:/i.test(repository)
    ?repository:'source-sha256:'+fingerprint({repository});
}
