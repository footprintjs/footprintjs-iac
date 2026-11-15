# Discover hosts, prepare a platform, then deploy workloads

The host-only `footprintjs-iac/platform` API composes access, measured discovery,
installation policy, lifecycle adapters and native recorded execution. Neo and
other application consumers choose those adapters in their composition root;
the base workflow contains no application-specific branches.

The order is:

```text
Existing server access profile
  → Discover measured host facts
  → Assess a sealed cluster plan
  → For each planned action: discover → revalidate → retain intent → execute
  → Find the physical cluster
  → Publish a distinct Kubernetes access profile, or pause for human input
  → Connect → Verify
  → Hand the registered cluster to the workload deployment layer
```

This extends the existing Create/Find → details → Connect → Verify model.
FootPrint runs the bootstrap charts; `ResourceFlowWorkflow` runs the subsequent
connection. Each chart has one construction file. There is no separate execution
engine. Management access and Kubernetes access remain distinct immutable
profiles. Secrets, installer scripts, SSH keys and raw kubeconfig never belong
in the shared chart scope or plan JSON.

## Public modules

| Module | Responsibility |
| --- | --- |
| `footprintjs-iac/platform/access` | Local and SSH transports, fixed discovery and multi-host dispatch |
| `footprintjs-iac/platform/bootstrap` | Topology intent, strategies, kubeadm/existing adapters and pinned preparation recipes |
| `footprintjs-iac/platform/workflow` | Native execution, retained state, pause/resume and evidence admission |
| `footprintjs-iac/platform/kubernetes` | Pinned read-only inspection/readiness for an existing cluster |
| `footprintjs-iac/platform` | Host composition exports for these modules |

Discovery measures OS/distribution/version, architecture, CPU, total/available
memory, disk space, privilege, tool versions and known Kubernetes configuration.
Visible Linux cgroup limits reduce reported CPU/memory capacity. An unavailable
measurement stays unknown. The absence of one config file does not prove that
there is no Kubernetes installation.

Topology is intent: the caller lists the machines and their desired roles.
Inspecting one machine cannot decide that the user wants three machines. Existing
cluster mode can use an empty host list and no SSH discovery; the cluster adapter
uses its registered connection instead.

## Access and discovery

```ts
import {
  createSshHostAccessTransport, FixedHostDiscovery, HOST_INVENTORY_ACTION,
} from 'footprintjs-iac/platform/access';

const host = { id: 'server-1', scope: 'office-management', profileId: managementProfile.id };
const transport = await createSshHostAccessTransport({
  host, hostname, username, knownHostsFile, identityFile,
  actions: [HOST_INVENTORY_ACTION], // trusted host registrations, not request JSON
});
const discovery = new FixedHostDiscovery({ transport });
const facts = await discovery.inspect(host, {
  executionId: 'inventory-run', operationId: 'inspect-server-1',
});
```

SSH uses a dedicated literal-host known-hosts file, strict key verification,
key-only authentication and bounded noninteractive execution. It does not load
the user's SSH configuration or forward the user's agent. Credential/trust files
are pinned and copied into a private temporary directory for each request.
Changed files refuse further access. Errors do not contain command bodies,
stderr, credentials or causes.

`LocalHostAccessTransport` has the same registered-action contract.
`HostDiscoveryRegistry` dispatches exact admitted host references to multiple
discovery adapters without a technology switch in the core. It snapshots adapter
methods and commits the registration identities into its own ID.

The tool inventory is an extensible dictionary. A provider can report another
runtime or installer without editing the generic facts contract. A missing tool
entry is unobserved; the kubeadm adapter explicitly requires its own tooling.

Both transports default to read-only operation. A mutation needs the explicit
host-side `allowMutations: true` registration and an `expectedIdentityDigest` from
the reviewed plan. The actual machine identity is checked in the same shell as
the action, immediately before the registered program runs. Raw command output
is a private adapter value and must be projected before it reaches a recorder.

## Preparation and installer strategies

`ClusterBootstrapStrategy` is a pure policy interface. `KubeadmClusterAdapter`
owns provider compatibility and common admission after policy evaluation. A
custom strategy cannot turn missing capabilities into permission to install,
omit required preparation or substitute an unregistered action.

The first kubeadm adapter supports one control-plane node plus explicitly listed
workers. The plan orders preparation, initialization, CNI networking and joins.
Desired Kubernetes version and network configuration are explicit. Capacity,
tool versions, physical identities, site readiness and fresh observations are
checked before each effect. A successful revalidation creates a short-lived,
one-use adapter admission; direct execution without it is refused.

`PinnedRecipeHostPreparation` connects a site-specific preparation plugin to this
plan. Register reviewed artifacts already delivered to the host, not arbitrary
shell text supplied by a dashboard request:

```ts
import { PinnedRecipeHostPreparation } from 'footprintjs-iac/platform/bootstrap';

const preparation = new PinnedRecipeHostPreparation({
  id: 'office-host-preparation',
  recipes: [{ hostId: host.id, id: 'prepare-server-1',
    recipePath: '/opt/company/reviewed-kubernetes-setup.sh',
    recipeSha256: approvedRecipeSha256 }],
  probe: sitePreparationProbe,
});
// Include preparation.hostActions(host.id) in that host's trusted transport.
```

The read-only probe supplies measured checks for node cleanliness, network,
configuration, CNI artifacts, packages and runtime. A `preparable` host can plan
registered setup actions with packages/runtime still missing; the other site
preconditions must already pass. After preparation the workflow rediscovers the
host, and init/join requires the actual expected software versions and readiness.
An exit code from an installer is not a substitute for those measurements.
The probe includes the originating `observedAt` timestamp; cached results retain
their age and cannot become fresh merely because an adapter was called again.

Each recipe is copied privately on the managed host, checked against its exact
SHA-256 and then executed. Its output is suppressed at this boundary. The fixed
`createKubeadmHostAction` factory similarly copies and checks approved init/join
configuration or CNI manifests, retains private kubeconfig on the host and emits
only a fixed completion marker. Join credentials never become plan arguments.

This is not a universal OS package installer. Your pinned recipe/provider plugin
owns the distribution-specific repositories, package/runtime versions, artifact
delivery and site network settings. An unsupported or unverified prerequisite
blocks the plan. Different installers and preparation tools implement the same
interfaces; no new generic orchestration engine is needed.

## Recorded execution and human input

`createPlatformClusterWorkflow(options)` takes a registered resource definition,
bootstrap intent, hosts/discovery, lifecycle adapter, private directory, immutable
profile catalog and host-owned `resolveDetails`/`connect` ports. Its safe state is
available through `start()`, `snapshot()` and `resume({ pauseToken, profileId })`.
The directory and executable ports are backend registration, never caller JSON.

Freshness defaults to 30 seconds. Missing identities, expired/future observations,
wrong versions, insufficient capacity, changed registered actions and unverified
site checks stop mutation. Every individual action receives durable intent before
execution. After a write is sent, a missing or invalid outcome remains uncertain;
reopening the workflow does not resend it or reset the machine.

Cluster creation retains its new physical cluster identity before later steps.
Existing mode pins the found identity in its plan and never falls back to create.
Missing automatic access publication uses FootPrint's native interrupt. Register
a new immutable Kubernetes profile and answer the exact retained pause token.
Resume rechecks physical identity and does not repeat preparation or installation.

`createHostAccessWorkflow` separately reuses existing-resource `ResourceFlowWorkflow`
for server access, including human profile selection. A server SSH profile cannot
silently become the Kubernetes profile after installation.

Verification requires measured API, node readiness, system-pod readiness and CNI
readiness. The `ClusterConnectionPort` owns private credential publication and
actual provider inspection; an API response alone cannot approve the platform.
For a newly created cluster, this plugin must establish the newly generated
certificate/cluster identity. It must not silently adopt an unrelated cluster.

The existing-cluster `PinnedKubernetesClusterConnection` provides a concrete
GET-only implementation. Registration pins endpoint, exact CA bytes and namespace
UID. It measures server version, expected node set/readiness, system pods and the
configured CNI resource; partial/missing observations fail verification. Its TLS
client does not follow redirects or expose provider response bodies. The selected
immutable profile must be bound to this registered client. This does not perform
post-init credential discovery for a newly created cluster: the site publisher
continues to own that private task.
CNI readiness here is controller rollout/readiness evidence. Pod-to-pod traffic,
DNS resolution and application connections require separate data-plane checks.

## Run the controlled example

```sh
npm run check
npm test
npm run build
node examples/platform-bootstrap.ts /private/tmp/my-platform-review
```

Choose a new output directory. The demo explicitly uses controlled host/process
fixtures: it changes no host system and establishes no production readiness.
It exercises the concrete adapters through preparation → init → CNI, a native
human pause, reopened resume, connection verification and Find without host SSH
or installer actions. Seven retained native captures and read-only backwalk
proofs are available in the chosen directory.

## Evidence and boundaries

Saved native assessment/execution records have full read/write provenance and
separate action, validation and intent stages. Public evidence readers support
read-only replay and backwalk. The recording reader checks trace completeness;
reopening checks retained plan/resource/action receipts against native evidence.
Separate runs are linked by explicit retained references/digests; this is not a
claim of universal automatic cross-run causal inference.

Use one coordinator and retained store per physical deployment target. Provider
observations across requests are point-in-time measurements, not an atomic or
distributed transaction. Protect registered credentials, recipes and kubeconfig
from concurrent retargeting by other operators.

This library change does not install Kubernetes on a real server, deploy Neo,
implement every Linux distribution, configure ingress/storage automatically or
change Lens's UI. Lens integrations can consume the safe workflow state and
native recordings. Application deployment still uses the separate guarded
[Kubernetes workload adapter](kubernetes-workload.md), with its own namespace,
configuration, dependency assessment and post-deployment checks.
