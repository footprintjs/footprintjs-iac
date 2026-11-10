import { defineIdentitySource } from '../identity/source.ts';
import type { IdentitySource, IdentityBindingAdapter } from '../identity/types.ts';
import { freeze, jsonCopy, keys, object } from '../graph/data.ts';
import type { LdapBindingOptions, LdapFederationBinding } from './types.ts';

/** Pure LDAP-to-broker binding; credentials are resolved by the broker at runtime. */
export class LdapIdentityAdapter implements IdentityBindingAdapter<LdapBindingOptions, LdapFederationBinding> {
  readonly id = 'ldap-keycloak';
  bind(sourceInput: IdentitySource, optionsInput: LdapBindingOptions): LdapFederationBinding {
    const source = defineIdentitySource(sourceInput);
    const value = object(jsonCopy(optionsInput), 'LDAP binding');
    keys(value, ['url', 'usersDn', 'groupsDn', 'bindDn', 'bindSecret', 'trust'], 'LDAP binding');
    keys(object(value.bindSecret!, 'LDAP secret reference'), ['environment'], 'LDAP secret reference');
    keys(object(value.trust!, 'LDAP trust reference'), ['certificatePath'], 'LDAP trust reference');
    const options = value as unknown as LdapBindingOptions;
    const url = new URL(options.url);
    if (url.protocol !== 'ldaps:' || url.username || url.password || !url.hostname || url.search || url.hash
      || !['', '/'].includes(url.pathname)) throw new Error('LDAP binding requires a credential-free LDAPS endpoint');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(options.bindSecret.environment)) throw new Error('Invalid LDAP secret reference');
    for (const value of [options.usersDn, options.groupsDn, options.bindDn, options.trust.certificatePath]) {
      if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid LDAP binding value');
    }
    const config = {
      enabled: ['true'], priority: ['0'], vendor: ['other'], editMode: ['READ_ONLY'],
      importEnabled: ['false'], syncRegistrations: ['false'], cachePolicy: ['NO_CACHE'],
      connectionUrl: [url.href.replace(/\/$/, '')], usersDn: [options.usersDn], bindDn: [options.bindDn],
      bindCredential: ['${' + options.bindSecret.environment + '}'], authType: ['simple'],
      usernameLDAPAttribute: ['uid'], rdnLDAPAttribute: ['uid'], uuidLDAPAttribute: ['entryUUID'],
      userObjectClasses: ['inetOrgPerson, organizationalPerson'], searchScope: ['1'],
      connectionTimeout: ['3000'], readTimeout: ['3000'], connectionPooling: ['false'],
      useTruststoreSpi: ['always'], startTls: ['false'],
    };
    return freeze({ sourceId: source.id, adapterId: this.id,
      secretReferences: [{ environment: options.bindSecret.environment }], trustCertificatePath: options.trust.certificatePath,
      component: {
        id: source.id, name: source.id, providerId: 'ldap', config,
        subComponents: { 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper': [
          ...[['username', 'uid'], ['email', 'mail'], ['firstName', 'cn'], ['lastName', 'sn']].map(([attribute, ldapAttribute]) => ({
            name: attribute, providerId: 'user-attribute-ldap-mapper',
            config: { 'user.model.attribute': [attribute], 'ldap.attribute': [ldapAttribute], 'read.only': ['true'],
              'always.read.value.from.ldap': ['true'], 'is.mandatory.in.ldap': ['true'] },
          })), {
          name: 'directory-groups', providerId: 'group-ldap-mapper',
          config: { 'groups.dn': [options.groupsDn], 'group.name.ldap.attribute': ['cn'],
            'group.object.classes': ['groupOfNames'], 'membership.ldap.attribute': ['member'],
            'membership.attribute.type': ['DN'], 'membership.user.ldap.attribute': ['uid'],
            'preserve.group.inheritance': ['false'], mode: ['LDAP_ONLY'],
            'user.roles.retrieve.strategy': ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE'],
            'drop.non.existing.groups.during.sync': ['false'] },
        }] },
      },
    });
  }
}
