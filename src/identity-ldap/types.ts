export interface LdapBindingOptions {
  url: string;
  usersDn: string;
  groupsDn: string;
  bindDn: string;
  bindSecret: { environment: string };
  trust: { certificatePath: string };
}
export interface LdapFederationBinding {
  sourceId: string;
  adapterId: 'ldap-keycloak';
  secretReferences: { environment: string }[];
  trustCertificatePath: string;
  component: Record<string, unknown>;
}
