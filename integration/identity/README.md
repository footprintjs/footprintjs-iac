# Local Neo identity and access integration

This optional integration binds a generic identity source and exact permission policy to Neo. OpenLDAP is the directory adapter; Keycloak provides OIDC authorization-code login with PKCE. Neo verifies signed access tokens and enforces `neo:chat` on `neo` for its protected application routes. A reader is allowed; a signed-in guest is denied. Existing conversation ownership checks remain in the app.

The default Neo fixture and its existing namespace are unchanged. This integration creates a separate namespace in an explicitly prepared local recording cluster and two ownership-labelled local containers on its `kind` network. Every creation, start/stop, repair and cleanup goes through `InfraEngine`. The container adapter is a narrow local fixture adapter, not a general Docker deployment provider.

## Scope

- LDAP uses a validated certificate, real user bind and real group lookup. Credentials are random private local files, never graph values or dashboard inputs.
- Browser login uses the provider's real authorization-code/PKCE flow. The separate `neo-checks` client permits password exchange only for the local acceptance harness; the browser client disables it.
- The policy is application-wide. It does not yet assign separate chat/admin/export/tool permissions, create Kubernetes RBAC or establish production network isolation.
- The Python tool server binds only loopback inside the Neo Pod. Its health probe executes inside that container; it is not a second unauthenticated application endpoint.
- LDAP and broker data are deliberately ephemeral. The broker uses development mode, with HTTP on the local test network. Production requires its own supported persistence, HTTPS, directory, secrets and deployment design.
- An LDAP outage affects fresh credential checks. Previously signed access tokens can remain valid until expiry; these tests do not claim immediate revocation.
- Ordinary Neo Metrics/Evidence HTML navigation has not been validated with this protection layer; unclassified application routes remain closed.

## Prepare and deploy

Requirements: Node 24+, Git, Docker's Linux engine, kubectl, OpenSSL, and the sibling IaC Lens checkout. Build the core and Lens using their documented local checks. The Neo checkout must contain the identity gateway, browser login and isolated `neo-access-recorder` package; the historical Neo fixture commit alone does not include this feature.

The tested consumer is the private Neo branch `feat/neo-identity-ldap-20261110`,
commit `5e23d8271c7430ae4bbb9a2e306caebc6c2993a3`. It includes the source-pinned
file-telemetry correction and passes the complete Neo gate with the owned
store available and with Docker unavailable. Obtain that exact source before
preparing the identity integration:

```sh
git clone --branch feat/neo-identity-ldap-20261110 https://github.com/sanjay1909/neo-agentfootprint.git neo-agentfootprint-identity
cd neo-agentfootprint-identity
npm ci
```

Return to the core checkout for the commands below. The branch retains its
recorded base; it does not overwrite or implicitly merge newer Neo main changes.

Prepare a recording cluster first using `npm run neo:prepare-fresh -- /path/to/Neo` from the core repository. This creates a private cluster descriptor without applying the ordinary Neo graph. Alternatively, explicitly choose a previously prepared local recording-cluster descriptor; this integration uses a new namespace and state directory.

```sh
npm run identity:prepare -- .artifacts/neo/fresh/latest.json
```

Pin the printed identity `target.json` path for the whole test. Do not switch to a newly changed `latest.json` halfway through. Preparation builds the local LDAP image, pins image identities and generates sealed private fixture files. It does not deploy Neo.

```sh
npm run identity:deploy -- /printed/identity/target.json --identity-only
```

The first stage creates the real directory and broker and records their deployment. The broker's observed private address is then bound into the Neo configuration.

For a local reviewed source snapshot, stage only the reviewed Neo changes and obtain `git write-tree` in that checkout. No commit or publishing is implied. The explicit build helper archives that exact tree, refuses credential files and unstaged tracked changes, builds both images, and records the base commit and tree hash:

```sh
node integration/identity/build-neo.ts /path/to/Neo REVIEWED_TREE_HASH /printed/identity/target.json
npm run identity:deploy -- /printed/identity/target.json
```

The second apply preserves the directory and broker and creates Neo's namespace, policy ConfigMap, Deployment and Service. Compare the recorded commit and tree with the source you reviewed. An image build does not replace the full Neo acceptance gate; an uncommitted index snapshot remains explicitly a reviewed local build.

Start a loopback port-forward in another terminal using the descriptor's explicit selectors:

```sh
kubectl --kubeconfig KUBECONFIG_FROM_DESCRIPTOR --context CONTEXT_FROM_DESCRIPTOR --namespace NAMESPACE_FROM_DESCRIPTOR port-forward deployment/neo NEO_PORT_FROM_DESCRIPTOR:5230 --address 127.0.0.1
```

From the Lens sibling:

```sh
node examples/neo-identity.ts /printed/identity/target.json
```

Open the printed dashboard URL. It displays the saved real deployment and runs fresh identity checks through **Check identity and access**. The evidence dropdown opens the native recorded verification chart. Deployment status is independent of identity checks. The private `credentials.json` contains the local Alice reader and Bob guest accounts; never forward this file or the fixture directory.

## Failure and recovery

The fault command verifies that only the owned directory resource will change. Leave the dashboard process running, then:

```sh
npm run identity:fault -- directory-down /printed/identity/target.json
```

Click **Check identity and access**. The real LDAPS connection and fresh login checks must become unavailable/failed. A provider's generic credential-error response during a confirmed directory outage is not counted as evidence of an incorrect password. Anonymous and forged-token refusals can still pass independently.

Always restore, including after a failed assertion:

```sh
npm run identity:fault -- restore /printed/identity/target.json
npm run identity:verify -- /printed/identity/target.json
```

Check again in Lens. Require directory availability, correct login, wrong-password rejection, anonymous refusal, actual Neo reader access, actual signed-in guest denial and forged-token refusal. A refusal passes only when it is the expected measured outcome. `identity:verify` persists the native record and traces and checks read-only replay/backwalking.

Evidence lives under the pinned target: `state/`, `deployment-traces/`, `identity/`, `identity-traces/`, `faults/` and `lens/identity/`. Neo's actual permission decisions are independently recorded inside its private access-recorder worker. Paths, user/group IDs and policy facts are still sensitive local evidence; no guarantee is made for a trusted extension that deliberately inserts secrets into otherwise permitted diagnostic fields.

When finished, the explicit ownership-checked cleanup removes this integration's workloads and local identity containers. It retains its namespace as protected inventory; it does not cascade-delete a namespace, the shared cluster or other Neo workloads:

```sh
npm run identity:cleanup -- /printed/identity/target.json
```
