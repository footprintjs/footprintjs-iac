# Identity sources, permissions and recorded checks

Compute executes, storage retains state and network connects components. Identity establishes who is asking; permissions decide which actions that verified subject may perform. Identity/access is a crosscutting concern, not another concrete infrastructure brand in the capability API.

The current API separates pure declarations/evaluation, authentication adapters, recorded authorization and recorded acceptance checks. It does not implement a universal identity control plane.

## Generic declarations and exact policy evaluation

```ts
import { defineIdentitySource } from 'footprint-iac/identity';
import { defineAccessPolicy, evaluateAccess } from 'footprint-iac/identity/policy';

const directory = defineIdentitySource({ id: 'company-directory', kind: 'directory' });
const policy = defineAccessPolicy({ id: 'neo-access', rules: [{
  id: 'readers', effect: 'allow', source: directory.id,
  groups: ['neo-readers'], actions: ['neo:chat'], resources: ['neo'],
}, {
  id: 'suspended', effect: 'deny', source: directory.id,
  groups: ['suspended'], actions: ['neo:chat'], resources: ['neo'],
}] });

const decision = evaluateAccess(policy, verifiedSubject, { action: 'neo:chat', resource: 'neo' });
// decision: effect, policyId, matchedRuleIds, reason.
```

`IdentitySource` has `id`, `kind: 'directory'` and `ownership: 'external' | 'managed'`. Ownership defaults to `external`: a reference to an existing company directory does not authorize creating, changing or deleting its users. Explicit `managed` describes intent; a supported deployment adapter is still required to implement management. `IdentityBindingAdapter` is a synchronous compiler extension. Calling `bind` alone does not contact or provision a provider.

`IdentitySubject` contains only `id`, `source` and `groups`. A trusted authentication adapter must establish these values. Validating this shape does not prove that an arbitrary object supplied by a caller is authenticated. The host fixes the source from its trusted provider configuration rather than accepting a caller-selected source.

A policy rule contains an ID, `allow` or `deny`, an exact source, exact actions/resources, and subject and/or group lists. Matching is:

`source AND (subject OR group) AND action AND resource`

Subject and group lists are alternatives. A matching explicit deny wins over any matching allow, regardless of declaration order. With no matching allow, the decision is `denied` with reason `default-deny`. Matching is case-sensitive, with no wildcard or prefix expansion. Wildcards, control characters, duplicate entries, ambiguous edge whitespace and unknown fields are rejected. Definitions are detached and deeply frozen.

`evaluateAccess` performs no I/O or recording. The `/identity/policy` export imports no Node, LDAP, React or workflow runtime modules, so it can also evaluate policies in a worker. A browser-side evaluation is a preview; the trusted server must independently verify identity and enforce authorization before serving protected data.

## Recorded authorization

```ts
import { authorizeAccess } from 'footprint-iac/identity';

const run = await authorizeAccess({
  policy, subject: verifiedSubject, action: 'neo:chat', resource: 'neo',
  stack: 'neo-access', traceDirectory: privateTraceDirectory,
});

if (run.decision.effect !== 'allowed') {
  // Refuse this request at the host boundary before protected work begins.
}
```

`authorizeAccess` records the validated policy, safe subject/groups, action and resource as native stage reads. It evaluates the same pure policy, records the matching rules/reason, and follows an explicit allowed or denied branch. Denial is a completed authorization decision, not a broken deployment. The returned decision must still be enforced by the host; this function does not insert HTTP middleware or grant a cloud role.

Each run returns a snapshot, chart structure, control dependencies, decisions, narrative and optional JSONL trace. Persist completed evidence in a private directory and publish a reference after the write completes. Local evidence/trace paths are local file locations, not URLs that another laptop can open. Share reviewed source and setup instructions rather than private artifact directories.

```ts
import { loadEvidence, replay, backwalk } from 'footprint-iac';

const evidence = await loadEvidence(savedPrivateEvidencePath);
const reconstructed = replay(evidence);
const explanation = backwalk(evidence, 'outcome');
```

The authorization `outcome` backwalk reaches its decision and recorded policy/subject/action/resource inputs. Replay and backwalk are read-only: they do not contact the directory, validate a token again, change permissions or undo an action. Recorded dependencies explain the captured evaluation; they do not prove the internal cause of an external provider failure or stitch separate runs into one causal history.

## LDAP adapters

`footprint-iac/identity/ldap` exports two separate adapters:

| Adapter | Responsibility |
| --- | --- |
| `LdapSourceAdapter` | Perform real read-only LDAPS user authentication and group lookup. |
| `LdapIdentityAdapter` | Produce LDAP-to-Keycloak federation configuration without contacting either service. |

`LdapSourceAdapter` implements the generic `IdentitySourceAdapter<IdentityCredentials>` interface. Configure a directory source, credential-free `ldaps://` endpoint, user/group base DNs, service bind DN, trusted CA PEM and an asynchronous `resolveBindPassword` closure. Optional `serverName` selects the expected certificate identity when a local forwarded address differs from the directory's certificate name. Credentials are transient `authenticate({ username, password })` inputs.

The adapter requires certificate verification and TLS 1.2+, uses fresh bounded clients, escapes LDAP search values, rejects referrals and ambiguous user results, and requests only the needed attributes. It finds an `inetOrgPerson` by `uid`, verifies that user's password through a separate bind, then reads `groupOfNames` memberships through the service identity. Subjects use stable `entryUUID` IDs and groups use `cn` values under the configured groups base. Other directory schemas and group conventions require their own supported mapping; this is not a general Active Directory schema adapter.

Empty credentials cannot trigger anonymous binds. Unknown users and LDAP invalid credentials from the user bind return `rejected`. Service-account failures, TLS/transport errors, ambiguous identities and failed group lookup return `unavailable` with a bounded diagnostic code. Backend uncertainty never becomes an allowed subject or an empty successful group lookup. Successful authentication does not grant application permissions; evaluate and enforce a separate policy.

`LdapIdentityAdapter.bind(source, options)` takes an LDAPS endpoint, user/group base DNs, bind DN, a bind-password environment **reference**, and a trusted certificate path. Its frozen output declares read-only/no-cache federation and group mapping for Keycloak. The output contains an environment placeholder instead of a bind password. The broker must resolve that reference and use the actual trust configuration at runtime; a successful pure bind is not proof of connectivity, certificate trust or login success.

Keep provider selection in adapters. The application-facing policy uses a generic source such as `company-directory`; it does not switch on LDAP, Keycloak or a cloud vendor.

## Recorded login and access checks

```ts
import { checkIdentityAccess, createIdentityRecorder } from 'footprint-iac/identity';

const recorder = createIdentityRecorder();
const unsubscribe = recorder.subscribe(event => showProgress(event));
try {
  const run = await checkIdentityAccess({ stack: 'neo', checks: [
    { id: 'login', label: 'Reader signs in', kind: 'login', expected: 'authenticated' },
    { id: 'guest', label: 'Guest is refused', kind: 'access', expected: 'denied' },
  ], adapter: liveChecks, recorders: [recorder], traceDirectory: privateTraceDirectory });
} finally { unsubscribe(); }
```

The trusted `AccessCheckAdapter` performs real calls using credentials held outside chart state. Check declarations contain only stable IDs, labels, kinds and expected verdicts. An observation contains a measured verdict, timestamp, latency and allowlisted metadata. Raw response bodies, credentials, authorization headers and provider error messages are not accepted observation fields. Adapter exceptions become a fixed unavailable/error-code outcome rather than being copied into the recording.

Native events are `checking`, `passed` and `failed`. `passed` means the observed verdict matches the declared expectation: an actual denied request can therefore be a passed negative test. `unavailable` is distinct from authenticated/rejected/allowed/denied. Identity/backend failures retain their own failed checks and do not overwrite successful infrastructure readiness. Each check's `progress:<checkId>` backwalk reaches its request, observation and governing native branch.

The metadata allowlist is a shape boundary, not universal secret detection. Trusted extensions must not put a password or token into an allowed label, subject ID or other metadata value. Graphs and snapshots retain declared JSON, so never put secret material in graph specs, policies or recorder metadata. Use private secret files/resolvers or provider-specific secret references, review files before sharing them, and apply an appropriate retention/access policy to saved evidence.

## Neo scope and current limits

The [Neo identity integration](../integration/identity/README.md) composes an isolated local directory fixture, a provider using LDAP federation, a browser OpenID Connect login flow and Neo's verified bearer-token/application permission boundary. Its API checks include directory availability, valid/invalid login, anonymous/forged requests, an allowed reader and a denied guest. Failure and recovery use new real observations; saved replay never repairs the provider.

The current permission is app-wide action `neo:chat` on resource `neo`. It does not grant individual agent-tool permissions, cloud IAM privileges or Kubernetes RBAC. Directory service-account permissions, identity-provider administration and the credentials used to deploy infrastructure remain separate concerns. An authentication outage can prevent new login while previously issued unexpired bearer tokens remain valid; a connectivity check is not a token revocation system.

The local fixture is ephemeral, with local development configuration and test identities. It does not establish production SSO readiness, durable/highly available identity storage, MFA, lifecycle provisioning, live revocation or a production secret-management system. Existing role/security boundaries and capability principals/`runAs` stay descriptive until an explicit supported adapter implements and verifies the requested behavior.
