import { isIP } from 'node:net';
import type { IdentityTarget } from './target.ts';

/** Fresh builds bind to the declared owned DNS name; old reviewed IP targets retain their exact graph. */
export function neoProviderJwksUrl(target: IdentityTarget): string {
  if (target.providerName !== `footprint-identity-${target.id}-provider`
    || !/^[a-f0-9]{8}$/.test(target.id)
    || (target.providerAddress !== undefined && isIP(target.providerAddress) !== 4)) {
    throw Error('Invalid prepared identity provider endpoint');
  }
  return `http://${target.providerAddress ?? target.providerName}:8080/realms/neo/protocol/openid-connect/certs`;
}
