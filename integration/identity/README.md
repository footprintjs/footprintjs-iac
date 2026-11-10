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

Requirements: Node 24+, Git, Docker's Linux engine, kind, kubectl, OpenSSL, and the sibling IaC Lens checkout. Build the core and Lens using their documented local checks. The Neo checkout must contain the identity gateway, browser login and isolated `neo-access-recorder` package; the historical Neo fixture commit alone does not include this feature.

Keep enough Docker VM memory available for the selected cluster, directory and
broker. Prefer a previously prepared owned recording cluster with a fresh
namespace when other tests must remain running. Keeping many kind clusters live
at once can exhaust the shared VM even while individual workloads are below
their container limits; repeated Kubernetes restarts or dropped forwards require
checking VM pressure before changing application limits.

The tested consumer is the private Neo branch `feat/neo-identity-ldap-20261110`,
commit `7f5e4546bfcc0f4586e641ab19375c43238165a8`. It includes the source-pinned
file-telemetry correction and native request-bound viewer grounding, and passes
the complete Neo gate with zero TODOs with the owned store available and with
Docker unavailable. Obtain that exact source before
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

Source metadata labels an admitted index `committed-clean` only when it matches
the exact captured commit's tree. A different staged tree remains
`reviewed-uncommitted-index`. The build records application-check and publication
status as `not-assessed-by-build`; those results require their own evidence and
are not inferred from a successful image build.

Start a loopback port-forward in another terminal using the descriptor's explicit selectors:

```sh
kubectl --kubeconfig KUBECONFIG_FROM_DESCRIPTOR --context CONTEXT_FROM_DESCRIPTOR --namespace NAMESPACE_FROM_DESCRIPTOR port-forward deployment/neo NEO_PORT_FROM_DESCRIPTOR:5230 --address 127.0.0.1
```

From the Lens sibling:

```sh
node examples/neo-identity.ts /printed/identity/target.json
```

Open the printed dashboard URL. It displays the saved real deployment and runs fresh identity checks through **Check identity and access**. The evidence dropdown opens the native recorded verification chart. Deployment status is independent of identity checks. The private `credentials.json` contains the local Alice reader and Bob guest accounts; never forward this file or the fixture directory.

## Watch a fresh deployment in Lens

Choose this sequence **instead of the two CLI deploy commands above**. Start with
a newly prepared identity target. Opening the viewer after a CLI apply can only
show saved results or an unchanged no-op, not a fresh creation.

From the Lens sibling, start the identity bootstrap viewer and open its printed
loopback URL:

```sh
node examples/neo-identity-live.ts /printed/identity/target.json --identity-only --port=15238
```

Click **Deploy system**. Wait for the real directory and sign-in provider to
become ready. The composition root records the provider's observed address. In
the core checkout, build the reviewed Neo tree:

```sh
node integration/identity/build-neo.ts /path/to/Neo REVIEWED_TREE_HASH /printed/identity/target.json
```

Then, from Lens in another terminal:

```sh
node examples/neo-identity-live.ts /printed/identity/target.json --full --port=15239
```

Open this second URL and click **Deploy system**. This stage preserves the two
identity services and creates the Namespace, policy ConfigMap, Deployment and
Service. Expand **Compute**, **Storage** and **Network** to see their mapped
resources move from pending through started to provider-confirmed ready. Progress
counts ready declared units; it is not a time estimate. A prepared cluster is an
existing prerequisite. Neo's seeded SQLite and session state are embedded in the
runtime, so they share Deployment readiness; no separate database server or
persistent volume is created.

After readiness, start the owned loopback forward from the core checkout:

```sh
node integration/identity/forward.ts /printed/identity/target.json
```

Use **Open Neo**, sign in with the local Alice reader, and ask **run a zone
redundancy audit for the RNV site**. The zero-key demo provider deliberately runs
this scripted audit over seeded data. It does not demonstrate general model
reasoning or disk drill-down. Bob signs in but receives **Access denied**.

Run **Check identity and access** before, during and after the directory fault
below. This fixture's seven measured identity checks are separate from generic
communication-edge probes, which remain **Not checked**. The native identity
recording is available through **Inspect identity recording**. To retain the
three dashboard phases for the acceptance helper, save each `/api/state`
response as `lens-baseline.json`, `lens-outage.json`, and `lens-recovery.json`
inside the pinned target directory without reapplying resources between checks.
Run `node integration/identity/proof.ts /printed/identity/target.json`, then
repeat with `--offline` to verify cached replay and backward slices.

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

Evidence lives under the pinned target: `state/`, `deployment-traces/`, `identity/`, `identity-traces/`, `faults/` and `lens/identity/` (or `lens-live-app/identity/` for the fresh-deployment viewer). Neo's actual permission decisions are independently recorded inside its private access-recorder worker. Paths, user/group IDs and policy facts are still sensitive local evidence; no guarantee is made for a trusted extension that deliberately inserts secrets into otherwise permitted diagnostic fields.

When finished, the explicit ownership-checked cleanup removes this integration's workloads and local identity containers. It retains its namespace as protected inventory; it does not cascade-delete a namespace, the shared cluster or other Neo workloads:

```sh
npm run identity:cleanup -- /printed/identity/target.json
```
