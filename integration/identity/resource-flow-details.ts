import type { ConnectionDetails, ResourceHandle } from '../../src/resource-flow/index.ts';
import { canonical } from '../../src/util.ts';
import { readIdentityJson } from './http.ts';
import type { IdentityTarget } from './target.ts';

export const neoFlowProfileId = (target: IdentityTarget) => 'neo-identity-profile-' + target.id;
export function expectedNeoFlowDetails(target: IdentityTarget, resource: ResourceHandle): ConnectionDetails {
  return { profileId: neoFlowProfileId(target), resourceId: resource.id, endpoint: target.issuer, protocol: 'oidc',
    credentialRef: 'neo-credentials-' + target.id, trustRef: 'neo-ldap-trust-' + target.id };
}

/** Inputs select a preconfigured profile; observed discovery confirms the actual endpoint after acquisition. */
export async function resolveNeoFlowDetails(target: IdentityTarget, resource: ResourceHandle,
  profileId: string | undefined, input: 'automatic' | 'human', requestFetch: typeof fetch = fetch): Promise<ConnectionDetails | undefined> {
  if (profileId === undefined && input === 'human') return undefined;
  if (profileId !== undefined && profileId !== neoFlowProfileId(target)) throw Error('Select the configured Neo identity profile');
  const response = await requestFetch(target.issuer + '/.well-known/openid-configuration', {
    redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' },
  });
  const discovery = await readIdentityJson(response, 64 * 1024);
  if (response.status !== 200 || discovery.issuer !== target.issuer
    || discovery.jwks_uri !== target.issuer + '/protocol/openid-connect/certs'
    || discovery.authorization_endpoint !== target.issuer + '/protocol/openid-connect/auth'
    || discovery.token_endpoint !== target.issuer + '/protocol/openid-connect/token') {
    throw Error('The acquired sign-in service did not expose its expected connection details');
  }
  return expectedNeoFlowDetails(target, resource);
}
export function assertNeoFlowDetails(target: IdentityTarget, resource: ResourceHandle, details: ConnectionDetails): void {
  if (canonical(details) !== canonical(expectedNeoFlowDetails(target, resource))) throw Error('The selected connection profile changed');
}
