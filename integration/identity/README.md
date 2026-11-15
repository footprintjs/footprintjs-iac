# Local Neo identity and access integration

This optional integration binds a generic identity source and exact permission policy to Neo. OpenLDAP is the directory adapter; Keycloak provides OIDC authorization-code login with PKCE. Neo verifies signed access tokens and enforces `neo:chat` on `neo` for its protected application routes. A reader is allowed; a signed-in guest is denied. Existing conversation ownership checks remain in the app.

## Separate Create/Find, Connect and Verify

For a complete portable setup with the published v2 consumer, local checks,
human process restart and outage/recovery proof, follow the dedicated
[resource workflow handoff](../../docs/NEO-RESOURCE-FLOW-HANDOFF.md). Keep its
Create/Find viewer sequence together; the later one-build instructions describe
the separate legacy viewer route.

The optional `createNeoResourceFlow` wrapper consumes the generic base
`ResourceFlowWorkflow`. It records four real native stages:

1. **Create resource** provisions only the directory and sign-in service, or
   **Find existing resource** reads and validates those already running services.
2. **Connection details** reads the acquired service's actual OIDC discovery
   document and resolves an allowlisted profile. Human mode pauses here, before
   any Neo consumer configuration, and resumes from a native checkpoint.
3. **Connect application** consumes those details to build Neo's issuer and
   authority configuration, applies only the four owned Kubernetes consumer
   resources, and opens or verifies its owned loopback forward.
4. **Verify connection and access** performs the same three real communication
   checks and seven identity/access checks described below. Each child native
   deployment and verification run has an explicit evidence receipt.

Prepare one target and its protected application images using the instructions
below. Leave its resources absent for the first run. From the Lens sibling:

```sh
node examples/neo-resource-flow.ts /printed/identity/target.json --mode=create --details=automatic --flow=create-auto --port=0
```

Opening the printed loopback URL performs no deployment. Start the workflow in
Simple mode. The acquisition plan contains two identity resources; Connect has
only the namespace, policy, Neo Deployment and Service. The two plans retain the
same stack name and durable inventory, so source ownership stays verified while
the Connect adapter has no source-resource mutation in its plan. Neo is first
deployed only after the identity binding is validated; no temporary unprotected
application is exposed.

After the first run, reuse the exact target as an existing-resource reference:

```sh
node examples/neo-resource-flow.ts /printed/identity/target.json --mode=existing --details=automatic --flow=find-auto --port=0
```

Find never invokes the source creation engine. It verifies the exact directory
and provider container identities and configuration through a read-only adapter.
The same Connect stage reconciles the consumer. An already configured consumer
will correctly produce no-op operations; Find does not claim to have created the
referenced services, and Connect never applies or removes them. This fixture
references its prepared local services; it does not discover arbitrary company
LDAP servers or silently import them into management.

Exercise a real human handoff with another execution ID:

```sh
node examples/neo-resource-flow.ts /printed/identity/target.json --mode=existing --details=human --flow=find-human --port=0
```

The flow stops at **Connection details** with Connect and Verify unstarted.
Choose the configured profile and continue. The input is an opaque profile ID,
not a password, endpoint or command. The host resolves credentials privately from
the sealed fixture. The pause releases the state lock. Restarting the same
command while paused loads the saved checkpoint; its one-use token, definition,
source identity, target, profile catalog and intended consumer configuration must
still match before connection can proceed. Resource acquisition is not repeated
when resuming at the details stage. Changed/replaced services fail before any
consumer mutation.

Execution state and native segments are retained under
`<target>/resource-flows/<flow-id>/`. `infra/` stores the actual two- or
four-resource child results, while `connections/` and `identity/` retain measured
checks. Lens Details exposes the public stage state, intended graphs and native
evidence; private credential and checkpoint files are not published as artifacts.
The flow leaves canonical `target.json`, existing master revision history, other
namespaces and other viewers unchanged. It does not promote a master revision
implicitly; its create/connect child recordings remain separately identifiable.

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

Requirements: Node 24+, Git, Docker's Linux engine, kind, kubectl, OpenSSL, and the sibling InfraChart Lens checkout. Build the core and Lens using their documented local checks. The Neo checkout must contain the identity gateway, browser login and isolated `neo-access-recorder` package; the historical Neo fixture commit alone does not include this feature.

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

Prepare a recording cluster first using `npm run neo:prepare-fresh -- /path/to/neo-agentfootprint-base-fixture` from the core repository. The separate base fixture and exact checkout steps are documented in the [laptop handoff](../../docs/NEO-AGENT-HANDOFF.md). This creates a private cluster descriptor without applying the ordinary Neo graph. Alternatively, explicitly choose a previously prepared local recording-cluster descriptor; this integration uses a new namespace and state directory.

```sh
npm run identity:prepare -- .artifacts/neo/fresh/latest.json
```

Pin the printed identity `target.json` path for the whole test. Do not switch to a newly changed `latest.json` halfway through. Preparation builds the local LDAP image, pins image identities and generates sealed private fixture files. It does not deploy Neo.

Build the protected consumer images **before opening Lens or applying any
resources**. For a local reviewed source snapshot, stage only the reviewed Neo
changes and obtain `git write-tree` in that checkout. No commit or publishing is
implied. The explicit build helper archives that exact tree, refuses credential
files and unstaged tracked changes, builds both images, and records the base
commit and tree hash:

```sh
node integration/identity/build-neo.ts /path/to/Neo REVIEWED_TREE_HASH /printed/identity/target.json
```

Compare the recorded commit and tree with the source you reviewed. An image build
does not replace the full Neo acceptance gate; an uncommitted index snapshot
remains explicitly a reviewed local build.

Source metadata labels an admitted index `committed-clean` only when it matches
the exact captured commit's tree. A different staged tree remains
`reviewed-uncommitted-index`. The build records application-check and publication
status as `not-assessed-by-build`; those results require their own evidence and
are not inferred from a successful image build.

## Watch one fresh build in Lens

Start with a newly prepared identity target whose protected images were built
above. Do not apply it through the CLI first: that would leave saved results or
an unchanged no-op for the recording.

From the Lens sibling, start the viewer once and open its printed loopback URL:

```sh
node examples/neo-identity-live.ts /printed/identity/target.json --port=0
```

**Simple** is the default. All six objects appear grey from the start:
Directory, Sign-in, Space, Access, Program and Network. Click **Build system**
once. The same chart follows grey → building → ready for all six real creates
in one native FootPrint deployment run. There is no identity bootstrap apply or
second page. `--full` remains an optional alias; this viewer rejects
`--identity-only`.

Fresh targets declare the provider's stable Docker-network hostname, so Neo can
be declared before the provider exists. The owned provider must become ready
before Neo runs. Connection probes verify DNS against that provider's observed
owned address and pin the HTTP connection to it. Legacy targets with a saved
provider IP remain supported. The build does not mutate the target or resource
graph to substitute an address.

The initial native schedule preview supplies positions only; it creates no
recorded starts or readiness. The actual native chart supersedes it at execution.
In **Details**, **Deployment flow** follows native resource execution and
**Running system** shows communication between those same resources. Select a resource for
its declaration, mapped capabilities, native operation and measured checks.
**Capabilities and placement** opens the logical inventory. Progress
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
Their generated passwords remain in private `credentials.json`; never forward
that file or the fixture directory.

The full viewer automatically checks all three communication paths after a
successful deployment: a real credential grant through the broker's uncached
LDAPS federation, a signing-key HTTP request from the Ready owned Neo Pod, and
an in-cluster Service DNS/ClusterIP health request. **Check connections** repeats
these point-in-time observations. Edges and status rows stream native
**Checking → Connected / Failed** events. They do not claim continuous traffic
monitoring. Resource colours retain the last recorded deployment outcome.

In Simple, use **Check** beside **Connections** or **Sign-in & access**; Details
labels these actions **Check connections** and **Check access**. Run access
checks before, during and after the directory fault below. The
seven measured identity checks have a separate native recording from the three
communication checks. The native identity
recording is available through **Inspect identity recording**. To retain the
three dashboard phases for the acceptance helper, save each `/api/state`
response as `lens-baseline.json`, `lens-outage.json`, and `lens-recovery.json`
inside the pinned target directory without reapplying resources between checks.
Run `node integration/identity/proof.ts /printed/identity/target.json`, then
repeat with `--offline` to verify cached replay and backward slices.

## Failure and recovery

The fault command admits the complete durable inventory and changes only the
selected existing owned resource. It preserves other supported recorded faults,
refuses unrelated repairs or replacements, and records every outage/restoration
through the normal engine. Leave the full dashboard running, then:

```sh
npm run identity:fault -- directory-down /printed/identity/target.json
```

Click **Check connections**, then **Check access**. The broker-to-directory
connection and fresh login checks must fail. The signing-key and Neo Service
paths can remain connected. A provider's generic credential-error response during
a confirmed directory outage is not counted as evidence of an incorrect password.
Anonymous and forged-token refusals can still pass independently.

Always restore, including after a failed assertion:

```sh
npm run identity:fault -- restore /printed/identity/target.json
npm run identity:verify -- /printed/identity/target.json
```

Check again in Lens. Require directory availability, correct login, wrong-password rejection, anonymous refusal, actual Neo reader access, actual signed-in guest denial and forged-token refusal. A refusal passes only when it is the expected measured outcome. `identity:verify` persists the native record and traces and checks read-only replay/backwalking.

Two further scoped fault pairs exercise the other communication paths:

```sh
npm run identity:fault -- provider-down /printed/identity/target.json
# In Lens: Check connections, then Check access; preserve this failed run.
npm run identity:fault -- provider-restore /printed/identity/target.json
# Recheck and preserve recovery before proceeding.
npm run identity:fault -- service-route-down /printed/identity/target.json
# Check connections: only the Service path should fail.
npm run identity:fault -- service-route-restore /printed/identity/target.json
# Recheck: all three paths must connect again.
```

A stopped provider fails both identity-related paths while the Neo Service can
still respond. The Service fault conditionally patches only its existing owned
target port to the unused test port `5999`; restoration returns its original
named port. Direct loopback app access and the seven identity checks can still
pass during that Service failure because the deployment port-forward bypasses
the Service route. Each check records its actual vantage point, owned identities,
target, observation time and bounded diagnostic result. Credentials, tokens and
signing-key bodies stay outside the recording.

Hosts can compose the same public integration without the example server:

```ts
import { checkConnections } from 'footprintjs-iac/connections';
import { loadIdentityTarget, createIdentityGraph, neoIdentityConnectionAdapter,
  applyNeoIdentityFault } from 'footprintjs-iac/integration/identity';

const target = await loadIdentityTarget('/printed/identity/target.json');
const graph = createIdentityGraph(target, { includeNeo: true });
const adapter = await neoIdentityConnectionAdapter(target);
const result = await checkConnections({ graph, adapter });
// A trusted local test host may invoke the same guarded fault workflow:
// await applyNeoIdentityFault(target, 'provider-down');
// Always restore it with 'provider-restore', including after failed assertions.
```

Evidence lives under the pinned target: `state/`, `deployment-traces/`, `identity/`, `identity-traces/`, `faults/` and `lens/identity/` (or `lens-live-app/identity/` for the fresh-deployment viewer). The full viewer also retains each `connections/<runId>.json` and `connection-traces/<runId>.jsonl`. Every check decision reads its own recorded result, including consecutive equal outcomes. Native replay and backwalking describe captured data/control provenance; they cannot establish an unobserved physical root cause. Neo's actual permission decisions are independently recorded inside its private access-recorder worker. Paths, user/group IDs and policy facts are still sensitive local evidence; no guarantee is made for a trusted extension that deliberately inserts secrets into otherwise permitted diagnostic fields.

When finished, the explicit ownership-checked cleanup removes this integration's workloads and local identity containers. It retains its namespace as protected inventory; it does not cascade-delete a namespace, the shared cluster or other Neo workloads:

```sh
npm run identity:cleanup -- /printed/identity/target.json
```

The Create/Find composition also exposes a browser-safe observation feed:

```ts
import { createNeoResourceFlow } from 'footprintjs-iac/integration/identity';
import type { NeoResourceFlowObservation } from 'footprintjs-iac/integration/identity/resource-flow-view';

const flow = await createNeoResourceFlow(preparedTargetPath, { mode: 'existing' });
const show = (value: NeoResourceFlowObservation) => render(value);
show(await flow.observation.snapshot());
const unsubscribe = flow.observation.subscribe(show);
await flow.workflow.start();
// These use the same fixed target and record new point-in-time native runs.
await flow.recheckConnections();
await flow.recheckIdentity();
unsubscribe();
```

The feed preserves the real two-resource acquisition chart and four-resource
consumer chart as separate runs. Find publishes the two measured physical
references and the actual parent acquisition stage; it creates no synthetic apply
chart. Each child run carries its parent execution and definition references.
Live connection and access recorder events include checking and their measured
outcome. Readiness alone never establishes a communication edge.

Reopening the same flow reads its pinned local evidence without provider calls.
Missing or invalid retained evidence stays unknown/incomplete. Earlier recordings
can recover their parent-pinned native runs; unavailable exact source lookup facts
stay unknown. Observer failures are isolated from execution. Rechecks first
validate the exact prepared target and physical ownership, permit a still-owned
stopped source to produce recorded failed probes, and refuse a replaced source.
They neither apply infrastructure nor change the original parent verification.
The public feed omits raw provider diagnostics and response bodies; the private
native evidence remains available for local diagnosis.
