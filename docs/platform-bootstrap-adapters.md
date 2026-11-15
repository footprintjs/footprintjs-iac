# Host discovery and cluster lifecycle adapters

The platform layer separates a machine's measured facts, installation policy,
host access, and cluster operations. The reusable library has no Neo dependency.
Run it through the recorded platform workflow; a provider method alone is not a
durable deployment coordinator.

The public contracts live in `footprint-iac/platform/bootstrap`:

- `HostPreparationPort` measures readiness for a reviewed OS/site recipe.
- `ClusterBootstrapStrategy` chooses a supported operation from recorded facts.
- `ClusterLifecycleAdapter` assesses, revalidates, performs one admitted action,
  finds the resulting cluster, publishes access, and verifies it.
- `ExistingClusterAdapter` performs read-only discovery and connection. A missing
  target stays missing; it never falls back to installation.
- `KubeadmClusterAdapter` creates one control-plane and the explicitly declared
  workers on compatible, verified Linux hosts. Multi-control-plane bootstrap is
  an unsupported result, not an inferred installation strategy.

Management host references and access transports come from
`footprint-iac/platform/access`. Host inventory measures OS, architecture, CPU,
RAM, disk, privileges and available tooling. Inventory does not choose a desired
topology or establish that every possible Kubernetes distribution is absent.
For create, the site preparation port must establish node cleanliness and the
cluster lookup must independently establish absence. Unknown observations stop
installation. Existing managed clusters can use an empty host topology and need
no SSH access to their underlying machines.

## Planning and strategies

`BootstrapIntent` declares `id`, `mode` and `topology`. Topology carries an exact
Kubernetes version and declared `{hostId, role}` nodes, with explicit Pod and
Service CIDRs for the kubeadm creation strategy. No hostname, secret or shell
script is interpolated from that intent.

A `BootstrapPlan` seals adapter/configuration identity, selected policy ID and
digest, physical host identities and the ordered registered actions. Full
observation hashes and safe preparation facts accompany the plan. Observation
timestamps and changing free-memory counters do not alter its semantic digest;
they are fresh evidence evaluated again before an effect. A custom policy can
block a compatible operation, but common admission prevents it from overriding
unknown capabilities, replacing target identities, omitting preparation or
adding unregistered actions.

`conservativeClusterBootstrapStrategy()` is the initial policy. Adapters can
register another immutable policy with its own ID and digest, while keeping the
same execution admission. Planning performs no installation.

## Preparing hosts

`PinnedRecipeHostPreparation` registers approved host-local recipes and a
read-only site probe. `hostActions(hostId)` supplies the trusted transport
registrations; plans contain their IDs/digests, not recipe bytes or paths.

The probe measures these six checks:

| Check | Meaning |
| --- | --- |
| `node-cleanliness` | This host is clear for the requested kubeadm operation. |
| `network` | The reviewed ports, routes, kernel settings and node communication are usable. |
| `configuration` | The pinned initialization/join configuration matches the intended site and version. |
| `cni-artifacts` | The selected networking artifacts are available and pinned. |
| `packages` | Required tooling is installed at the selected version. |
| `runtime` | The configured container runtime is available and compatible. |

A `preparable` result can plan registered preparation actions when packages or
runtime still need installation. Other site prerequisites must already be
established. After preparation, fresh discovery and the probe must report ready,
with actual kubeadm/kubelet/kubectl versions matching the intent and containerd
installed. Installing an arbitrary OS package set is not inferred from a Linux
distribution name. The approved recipe is the OS/site adapter; future Ansible or
vendor installers can implement the same preparation port.

The recipe action copies the approved local artifact into a private directory,
verifies its SHA-256, runs that exact copy and suppresses its private output.
There is no download URL, `curl | sh`, implicit latest version or reset command.
The site probe must be phase-aware: once this workflow has initialized/joined
its own host, the presence of its own kubeadm files is expected, while target
identity, runtime and remaining network requirements still require verification.

## Kubeadm execution

Register `createKubeadmHostAction()` in trusted host code, using an absolute
binary/configuration path and SHA-256. Its fixed commands are:

```text
kubeadm init --config <private-pinned-copy> --skip-token-print
kubectl --kubeconfig <private-host-file> apply --server-side=true --field-manager=footprint-bootstrap -f <private-pinned-CNI-copy>
kubeadm join --config <private-pinned-copy>
```

Configuration bytes and join tokens stay on the managed host. Init/join refuse
known existing Kubernetes markers immediately before running. The actual access
transport independently checks the sealed physical machine identity in its
execution prelude. The only accepted kubeadm completion output is a fixed safe
marker; a command exception or ambiguous postcondition remains an uncertain
effect and never becomes an automatic retry.

The plan orders registered preparation actions, initialization, CNI installation
and worker joins. `revalidate()` checks fresh facts, physical identities,
readiness and original action registrations. Success issues a short-lived,
one-use permit for exactly the next action. `executeAction()` consumes it before
sending, so direct calls without preflight, concurrent replay, changed plans,
stale permits and permits invalidated by a failed revalidation cannot mutate.
The workflow separately persists its intent before calling this operation.

Successful initialization must return the new cluster's actual physical
resource identity in the action receipt. The workflow retains that identity in
subsequent context. Every later operation rechecks it. A cluster substituted
between steps does not become the destination merely because its endpoint or
profile name is the same.

## Connection and verification

`ClusterConnectionPort` is a trusted host-side adapter. It reads actual cluster
identity, publishes a new immutable Kubernetes access profile, and performs
measured verification. Its lookup is distinct from SSH host access. Publishing
access must not change a saved management profile into a kubeconfig profile.
The publisher can return `undefined` so the recorded connection workflow pauses
for a human-selected admitted profile.

Cluster verification requires all of `api`, `nodes-ready`, `system-pods-ready`
and `cni-ready`; API health alone is insufficient. The registered connection
adapter must verify the expected node set, version and network behavior at the
actual target. A unit-test port returning passed flags is not production
verification. The host must protect its credentials and target files, maintain
one durable coordinator per physical target, and reconcile an uncertain effect
before another attempt. Point-in-time checks are not a distributed lock or an
atomic transaction across separate machine and Kubernetes calls.

Present observations additionally carry the actual API server `platformVersion`.
The generic contract accepts strict semantic versions, normalizes an optional
`v` prefix and preserves every prerelease/build identifier. Existing-cluster
connection requires exact requested/observed equality: `1.37.0+k3s1` can connect
to that exact provider version, while a request for `1.37.0` does not silently
match it. Missing, invalid or mismatched versions block connection.

Concrete compatibility stays with the provider adapter. The initial kubeadm
creator admits stable upstream `1.x.y` only and blocks other versions before
effects; a different installer can implement its own measured support policy
without changing the generic version schema.

The initial implementation is tested with controlled host/cluster ports and
real bounded local process fixtures. It does not install Kubernetes on the
developer laptop, contact Rahul's server, or establish production readiness.
