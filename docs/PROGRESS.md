# Native deployment progress and IaC Lens

The 0.4.0 foundation uses the existing FootPrint 11.1.0 recorder interfaces for live deployment observations. It does not introduce a second execution engine or infer deployment from animation. Foottrace 1.12.0 reads the captured evidence for replay and investigation.

## Attach a native recorder

```ts
import { InfraEngine, FileStateStore, SimulatorAdapter } from 'footprint-iac';
import { createDeploymentRecorder } from 'footprint-iac/progress';

const progress = createDeploymentRecorder();
const unsubscribe = progress.subscribe(event => {
  // Feed your console, transport or UI. Keep the complete resourceId.
  console.log(event.sequence, event.resourceId, event.status);
});
const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.artifacts/progress-example'),
  traceDirectory: '.artifacts/progress-example/traces',
  recorders: [progress],
});

try {
  const result = await engine.apply(simulationBinding.graph);
  console.log(result.ok, progress.getSnapshot());
} finally { unsubscribe(); }
```

Use a validated simulation binding in this example. A real graph requires its matching provider adapter and explicit target. `InfraEngine` accepts native `CombinedRecorder` implementations through `recorders`; consumers can attach multiple independent observations without replacing the engine's control-dependency recorder. Duplicate consumer IDs and the reserved internal control-recorder ID are rejected.

Use one deployment recorder per active apply. A new native executor run clears its projection. Subscribe before applying; unsubscribe when the consumer is finished. `getSnapshot()` returns detached, frozen projection containers. `getEvents(afterSequence)` returns sequenced events after a nonnegative cursor. Events from another run or with an invalid payload are ignored and counted. Subscriber exceptions are isolated from provider work and counted by `subscriberFailures`.

## Resource states

| State | Recorded meaning | Suggested system-chart treatment |
| --- | --- | --- |
| `pending` | The operation has entered this run's plan; reconciliation has not started. | Grey, with a pending label. |
| `deploying` | The resource's reconciliation stage has started. | An active indicator with a deploying label. |
| `ready` | Reconciliation completed after the adapter's readiness/convergence checks. | Ready colour and label. |
| `failed` | Reconciliation failed. | Failure colour, message and evidence link. |
| `skipped` | A preceding terminal failure prevented this operation from running. | A distinct skipped label. |
| `deleted` | The adapter confirmed the deletion was complete. | A removed state, distinct from readiness. |

The `action` remains separate: `create`, `update`, `verify`, `delete` or `noop`. A no-op is still observed and checked before becoming ready. Planned operations begin pending together; eligible parallel stages can deploy concurrently. Started siblings settle after a failure, while later batches are skipped. Colours are presentation choices; status text must remain visible.

Each `DeploymentEvent` carries `version`, `sequence`, the engine apply `runId`, the complete `resourceId`, `status`, `action`, the native event timestamp and `runtimeStageId`, plus a failure message when present. The projector consumes native `iac.resource.progress` events. The owning chart stage also writes `progress:<resourceId>` through the native scope, making the status part of replayable state rather than only an ephemeral UI message.

## Three complementary artifacts

- The desired `InfraGraph` describes resources, boundaries and relationships.
- The native deployment recording captures this run's stage reads/writes, proceed/skip decisions and outcomes.
- The live progress projection summarizes the observed state for each resource.

New apply evidence includes the native build-time chart `structure` beside its `snapshot`, `controlDeps`, `decisions` and `narrative`. Flow Lens can render the execution shape from that recording. Older evidence may lack `structure`; consumers must disclose that gap rather than inventing a chart. The durable operation journal remains separate from best-effort observer capture.

Planning and `bindSystem()` selection remain outside the recorded apply chart. Provider observations and retries are durably journaled, while the native trace sees their enclosing reconciliation stage. Replay reconstructs recorded state without provider calls; it does not reissue a deployment. Captured dependencies support investigation but do not prove every external provider's internal cause.

## Separate, optional UI

The [footprint-iac-lens](https://github.com/footprintjs/footprint-iac-lens) repository owns the separate dashboard and consumer server. The IaC foundation has no React dependency.

| Import | Responsibility |
| --- | --- |
| `footprint-iac-lens` or `/core` | Framework-neutral TypeScript client, transport contracts, system model and layout. |
| `footprint-iac-lens/react` | Optional React dashboard surface. |
| `footprint-iac-lens/server` | Explicit local consumer server and deployment-controller composition. |

The dashboard starts all declared resources grey, then projects native progress into its live system chart. Selecting a resource shows its full identity, desired data and observed outcome. The execution-evidence view uses the existing `footprint-explainable-ui` Flow Lens with the native snapshot and saved structure. The resource system view describes infrastructure; the Flow Lens view describes traversal. The distinction matters when a resource expands into several execution stages or one capability expands into multiple resources.

Framework-neutral consumers can supply their own request and event-stream transport:

```ts
import { createDashboardClient } from 'footprint-iac-lens/core';

const client = createDashboardClient({
  baseUrl: 'http://127.0.0.1:15231',
  fetch: yourFetch,
  openStream: yourStateStream,
});
const unsubscribe = client.subscribe({ state: renderState, error: showError });
```

Use the Lens repository's own setup instructions and printed URL; port15231 is preferred and a busy port can lead to a different local URL. Its simulator scenarios are explicitly labelled. The Neo option uses the separately prepared local fixture and the same `InfraEngine` mutation path; it is not a general remote-cluster deployment console. Model responses and data remain the packaged scripted/seeded fixture.

Checks, builds and local deployment commands run directly for now. Automatic GitHub CI triggers remain off. Keep `.artifacts/` evidence, state, kubeconfig and server process metadata local and private.
