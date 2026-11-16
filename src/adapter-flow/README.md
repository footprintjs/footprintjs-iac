# Native adapter subflows

The generic engine accepts provider ports. Import `/core` without a provider,
then import only the selected optional adapter:

```ts
import { InfraEngine } from 'footprintjs-iac/core';
import { DeploymentStrategyRegistry } from 'footprintjs-iac/deployment-strategy/registry';

const selected = await import('footprintjs-iac/deployment-strategy/systemd');
// selected.createSystemdHost, selected.createSystemdDeploymentAdapter,
// selected.compileSystemdDeployment. The Kubernetes implementation is not loaded.
```

`/deployment-strategy/kubernetes` separately exports `KubernetesAdapter` and
`createKubernetesDeploymentAdapter`. The existing root and
`/deployment-strategy` barrels remain compatible, including their eager imports.
Library imports and chart construction perform no provider calls.

A `ResourceAdapter` can supply two pure factories:

- `createApplyFlow(resource, providerContext, binding)` returns its native effect
  chart. The engine mounts it below a saved pending intent. An unchanged resource
  skips this mount.
- `createVerifyFlow(...)` returns an observation-only chart. The engine mounts it
  after readiness and a fresh resource observation, before checkpointing. This
  also runs on a no-op and never consumes an apply permit.

Both charts are true FootPrint subflows inside the parent deployment execution.
Use `createAdapterFlowChart` from `/adapter-flow/node` to declare small provider
phases, with ordinary `ScopeFacade` reads/writes and the supplied compatible
`AdapterFlowScope`. Native mounts use the parent's scope factory, so provider
charts must not rely on an unrelated custom scope subclass. Return
`adapterFlowOutcome` through the native output mapping; the helper handles this
contract. Legacy callbacks remain supported and are explicitly opaque wherever
their inner boundaries are unavailable. No second executor is started.

The built-in systemd host records actual boundaries: revalidate the registered
units, atomically write owned release markers, daemon-reload, restart the entire
registered group once, then inspect each process. Marker configuration is not a
software installation. Host identity, configuration and managed marker ownership
are checked between boundaries. A consumer's package-staging wrapper must compose
its complete staging/activation flow before exposing the factory; forwarding an
underlying factory would bypass that work.

Kubernetes records identity/precondition reads, conditional create or server-side
apply, readiness and final observation. The existing target guard composes its
preflight and ownership observations around the selected provider subflow. UID,
resourceVersion, field ownership and safe retry behavior remain enforced. These
phases describe actual kubectl boundaries, not simulated controller internals.

Use `createAdapterFlowRecorder` from `/adapter-flow` for provisional live events.
`deploymentRunId` is the controller UUID. `runId`, `logRunId`, `drillPath`,
`runtimeStageId` and `committedThroughIdx` come from FootPrint's native capture
position; `pipelineId` can be empty and is not the recording identity. Events
contain bounded IDs, phase/status and measured installed/running booleans. They
exclude raw transport output, provider errors and extra host binding fields.

For retained evidence, configure `traceDirectory` and call
`admitAdapterFlowEvents` from `/adapter-flow/node` with the evidence, exact plan,
registered component/resource bindings and retained events. It verifies the
complete native file and child logs, parent mount, desired input, operation and
intent, and component writes. Terminal facts are selected in native file commit
order. Removing or rearranging observer history cannot restore an older green
state; an empty observer history can still be reconstructed from recorded writes.
Incomplete or foreign captures are rejected. This reader performs no provider
calls. A live event remains provisional until its capture is admitted.

For an expanded live deployment view, `DeploymentChartObserver` optionally accepts
`onRecording`. `createDeploymentRecorder({captureStages:true})` explicitly enables
this optional work and provides `subscribeRecording` and `getRecording` for the
port. The default recorder retains its original resource/chart progress cost and
does not attach live native-stage hooks. Final retained native histories can still
be expanded without this option. These observations are metadata-only slices of the
actual native snapshot: stage addresses, committed stage identities, safe outcome
flags and exact selected branches. The persisted `iac-native-stage-progress`
recorder additionally retains actual scope start/end and flow decision/error
hooks, including in-flight child stages that have not returned into the parent's
snapshot yet. No scope inputs, arbitrary writes, raw errors or transport output
are published. Observer failures and dropped-event counts remain explicit.
Missing observations never imply completion or a skipped branch; these partial
display observations do not authorize effects or replace final native evidence.

When a requested native trace cannot be opened or loses an entry, execution does
not report success or retry the unknown effect. Saved pending intent remains
available for explicit reconciliation. Original callback-only workflows retain
their prior best-effort trace behavior.

The [registered system topology](../system-topology/README.md) maps these admitted
component facts onto server, VM, cluster and service boundaries. Deployment order,
component placement and verified communication checks remain separate models.

`defineSystemdTopology` from `/deployment-strategy/systemd` supplies a pure default
for an existing registered host. Pass `{id, label, targetId, hostLabel?, stack,
releaseDigest, units, transaction?}`. It reuses the unchanged systemd compiler,
declares the host, its systemd runtime and one existing Compute node per exact
unit ID/name, and binds each node to actual unit observations. Group and independent
transactions retain their original resource IDs. This declaration does not inspect
a host or infer application roles, databases, containers, software brands or network
connections. A consumer can supply a richer explicit topology when those facts
are registered separately.
