# Footprint IaC — capabilities, system graphs and recorded infrastructure

A TypeScript infrastructure framework built on **FootPrint 11.1.0** and **Foottrace 1.12.0**. Foundation version **0.4.0** describes compute, storage and network before selecting implementations. A binding profile expands that intent into a resource graph; the engine plans changes, records reconciliation, recovers uncertain creates and supports saved replay/backwalk. Native recorders also drive live deployment progress and checked output generation.

This is an executable prototype with a simulator, a Kubernetes adapter and recorded native artifact generation. The separate [IaC Lens](https://github.com/footprintjs/footprint-iac-lens) supplies a live system view and Flow Lens evidence inspection. This remains a single-machine foundation, not a production deployment service.

Start with the [capability and wrapper guide](docs/CAPABILITIES.md). See [VALIDATION.md](VALIDATION.md) for current checks and the earlier completed real Neo Kubernetes trial. The [design notes](docs/DESIGN.md) define graph semantics and implementation boundaries.

For another laptop, start with the [clone, setup and test guide](docs/SHARING.md). The [agent handoff](docs/NEO-AGENT-HANDOFF.md) is ready to forward with the repository link. Both this repository and the separate Neo source repository require GitHub access.

## Capability API

```ts
import { system, artifact, ref } from 'footprint-iac/system';
import { bindSystem, simulationProfile } from 'footprint-iac/binding';

const design = system('example')
  .addNetwork('network', n => n.addSegment('backend'))
  .addStorage('state', s => s
    .addSessionStore('sessions', store => store
      .sharing('shared').durability('persistent').expiration({ idle: '30m' }))
    .addDataStore('history', store => store.retainOnRemoval()))
  .addCompute('application', c => c.addService('api', service => service
    .program(artifact('api-program'))
    .useNetwork(ref.network('network.backend'))
    .useStorage(ref.store('state.sessions'), { access: 'readWrite' })
    .useStorage(ref.store('state.history'), { access: 'read' })))
  .build();

const binding = bindSystem(design, simulationProfile({
  artifacts: { 'api-program': { executable: 'fixture-api' } },
}));
// Inspect binding.decisions, binding.mappings and binding.graph.
// engine.plan(binding.graph) / engine.apply(binding.graph) use the existing engine.
```

The base contains three capability families. Identity/access and boundaries cross those families. Store purpose, data model, sharing, durability, expiration, retention and replication are separate properties. Recipe defaults are visible. Declaration and binding are synchronous; providers are touched only through the planner/engine.

The built-in capability binding profile is **simulation-only**. It records the requested behavior as simulated; it does not provision Redis/PostgreSQL or verify production durability/security. The explicit lower-level Kubernetes resource adapter remains available separately. The [Neo consumer profile](integration/neo/README.md#capability-binding-and-execution) supplies a narrow real Kubernetes implementation for its packaged local service and HTTP endpoint; `npm run neo:review -- --context kind-footprint-iac-test` deploys it and leaves a review server running. Unsupported/ambiguous bindings and unsupported required boundary rules fail explicitly.

`.use(recipe)` supports domain wrappers as compositions over the same public base. The separate agentic recipe example demonstrates that extension point; the core has no agentic/banking system-type switch. See [CAPABILITIES.md](docs/CAPABILITIES.md) for semantics and limits.

```sh
npm run capability:demo
```

The demo saves the capability definition, intent diagrams, binding decisions, expanded graph, reconciliation evidence and removal-retention report under `.artifacts/capabilities`. `systemToMermaid` and `systemToSvg` show intent before adapter selection; existing graph renderers show the expanded resource view.

## Run locally

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
npm test
npm run build
npm run demo
```

Run checks, builds and deployments directly on the local machine. Automatic GitHub CI triggers remain disabled; no workflow run is required for these commands.

The demo creates a simulated network and app, loses one provider response, reconciles without a duplicate send, verifies a no-op plan, injects an update failure, replays and backwalks the saved failure, then repairs it. Its files remain under the printed `.artifacts/demo-*` directory.

The CLI accepts a JSON stack:

```sh
npm run iac -- plan examples/simulator.stack.json
npm run iac -- apply examples/simulator.stack.json
# Repeat: unchanged resources are no-op operations.
npm run iac -- apply examples/simulator.stack.json
```

Each apply prints its `evidencePath`. Read that recording without executing a provider:

```sh
npm run iac -- explain /absolute/path/to/run.json --key failure
npm run iac -- replay /absolute/path/to/run.json
npm run iac -- replay /absolute/path/to/run.json --commit 0
```

`npm run build` produces the importable library in `dist/src`. The package remains private and has not been published.

## Recorded native outputs

With a Kubernetes-bound design, export the complete desired graph through native output recorders:

```ts
import { synthesize, kubernetesOutput } from 'footprint-iac/synthesis';

const output = await synthesize(binding.graph, {
  outputs: [kubernetesOutput(), kubernetesOutput({ format: 'yaml' })],
});
// output.artifacts: files, hashes, native/resource mappings and declared limitations.
// output.snapshot + output.structure: native synthesis recording for Flow Lens.
```

The synthesis flow records each desired resource and explicitly finalizes its output projections. It exports the whole desired graph independently of a deployment's create/update/no-op plan. Native recorder isolation cannot hide a broken output: incomplete coverage, callback failures, unsafe paths, invalid encoding and hash mismatches fail compilation. Generation performs no provider calls.

Kubernetes output produces JSON/YAML object lists in declared dependency order. A separate, narrow AWS object-storage profile produces CloudFormation JSON/YAML for persistent object stores using S3. It is **export-only**: no AWS deployment, schema service, authorization or live durability verification runs. Backend-specific references and retention need their own supported mappings. Terraform remains an extension point. Read the [output guide](docs/OUTPUTS.md) for the supported scope and examples.

```sh
npm run synthesis:demo
```

The demo writes native Kubernetes and CloudFormation files, source graphs and their synthesis recordings under `.artifacts/synthesis`. Binding selection itself remains pure compilation with static decision metadata; the new native recording covers generation from the bound graph and checked finalization.

## Live progress and IaC Lens

Attach the existing native recorder extension to an engine:

```ts
import { InfraEngine, FileStateStore, SimulatorAdapter } from 'footprint-iac';
import { createDeploymentRecorder } from 'footprint-iac/progress';

const progress = createDeploymentRecorder();
const stop = progress.subscribe(event => {
  console.log(event.resourceId, event.status, event.action);
});
const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.artifacts/progress-example'),
  recorders: [progress],
});
try { await engine.apply(binding.graph); }
finally { stop(); }
```

This example uses a simulation binding; provide the matching provider adapter for a real binding. Progress comes from recorded stages: `pending`, `deploying`, `ready`, `failed`, `skipped` and `deleted`. Ready follows provider confirmation, including on a no-op; a timer or successful API send does not make a node ready. New saved apply evidence includes its native build-time `structure` alongside the snapshot, decisions and narrative.

The independently versioned [footprint-iac-lens](https://github.com/footprintjs/footprint-iac-lens) repository supplies the separate dashboard. Its root and `/core` APIs expose TypeScript models and transport without React imports; `/react` provides the optional React surface using Flow Lens. The resource system chart and native execution chart are separate views: infrastructure relationships describe the system, while the execution recording shows what this run did. See [PROGRESS.md](docs/PROGRESS.md) for recorder usage, status semantics and the UI boundary.

Connection checks run in a separate native FootPrint chart, after resources are ready:

```ts
import { checkConnections, createConnectionRecorder, KubernetesConnectionAdapter } from 'footprint-iac/connections';

const connections = createConnectionRecorder();
connections.subscribe(event => console.log(event.connectionId, event.status));
const checked = await checkConnections({
  graph: binding.graph,
  adapter: new KubernetesConnectionAdapter({ context, kubeconfig, namespace, container: 'node', path: '/health' }),
  recorders: [connections],
  traceDirectory: '.artifacts/connection-traces',
});
```

The adapter supports a narrow, same-namespace Kubernetes Service → Deployment HTTP check. It verifies ownership and ready EndpointSlice backends, then executes a fixed Node probe in an existing ready target pod. The probe resolves the Service DNS name and sends an HTTP health request through its ClusterIP. Connected requires HTTP 200 with JSON `status: "ok"` and stable Service/backend identities before and after the request. It records the source pod, route, DNS answers, HTTP result, latency and failure details; it does not use a deployment port-forward to claim Service connectivity. The source container must have Node available. Unsupported targets fail explicitly.

Native `checking`, `connected` and `failed` events drive Lens communication edges. Each check saves its snapshot, structure, decisions, narrative and optional JSONL trace, including failed partial observations. Replay and backwalk inspect those captured inputs and outcomes without rerunning the network request. Checks are point-in-time observations from the recorded pod vantage point; they do not establish arbitrary-client reachability or continuous traffic monitoring. A failed connection does not rewrite a successful resource deployment as failed.

## Lower-level resource graph API

```ts
import {
  infra, resource, graphToMermaid,
  InfraEngine, FileStateStore, SimulatorAdapter,
} from 'footprint-iac';

const network = resource('network', 'simulator', { cidr: '10.42.0.0/24' });
const database = resource('database', 'simulator', { engine: 'example-sql' });
const cache = resource('cache', 'simulator', { capacity: 'small' });
const api = resource('api', 'simulator', { image: 'neo:v1' });

const graph = infra('neo')
  .boundary({ id: 'west', kind: 'region' })
  .boundary({ id: 'restricted', kind: 'security' })
  .start(network)
  .parallel(database, cache)
  .next(api)
  .within('west', network, database, cache, api)
  .within('restricted', database, cache)
  .connect(api, database, 'communicatesWith')
  .synth();

console.log(graphToMermaid(graph, { view: 'architecture', boundaryKind: 'security' }));
const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.footprint-iac'),
  maxConcurrency: 2,
});
const plan = await engine.plan(graph);
const result = await engine.apply(graph);
```

This declares `network → [database, cache] → api`. The parallel resources become eligible after the network converges; the API waits for both. `plan` observes the provider without mutating resources. `apply` refreshes the plan and reconciles current infrastructure. The graph is declared desired state, so a repeated apply does not blindly rerun every mutation.

`start` opens an independent chain. `next`/`serial` append a sequence. `parallel` forks from the current frontier; the next append joins all branch exits. `serialGroup` and `parallelGroup` compose nested branches. Existing dependencies remain active. Completion follows the provider's confirmation/readiness contract; declaring a reference or connection alone does not establish endpoint health.

`synth()` returns an immutable, validated `InfraGraph` JSON artifact containing concrete resources, typed relations, overlapping memberships, boundaries and a canonical digest. It makes no provider calls. Resource IDs stay stable when diagram grouping changes. `readInfraGraph()` validates saved JSON. Architecture relations may cycle; deployment `order` and declared `data` relations must form a DAG. Provider-output interpolation is not implemented.

Boundary kinds are `region`, `security`, `role`, `physical`, `ownership` and `group`. They describe independent views. Region/room membership does not select a provider or place a workload. A role is an architectural category. A security group does not create IAM, RBAC or network isolation. All `requirements` with `mode: 'required'` fail before provider observation until a supported enforcement adapter exists; advisory requirements stay declared intent.

Generate and exercise a complete example:

```sh
npm run graph:demo
```

The example emits graph JSON, Mermaid and standalone SVG views, then checks actual concurrency, uncertain-create recovery, no-op planning, failure replay/backwalk and repair. Outputs go to a fresh directory under `.artifacts/system-design`; `latest-report.json` points to the result. The [Neo consumer](integration/neo/graph.ts) adds boundary views to the exact Kubernetes resources from the previous trial.

A saved graph can also be passed directly to the CLI:

```sh
npm run iac -- plan /absolute/path/to/graph.json
npm run iac -- apply /absolute/path/to/graph.json --max-concurrency 2
npm run iac -- inspect /absolute/path/to/run.json
```

`inspect` exposes `explainRun()` as JSON: recorded failure, graph digest, declared boundary memberships and a flat Foottrace dependency slice. It makes no provider calls and retains coverage/missing/truncation notes. `graphToMermaid()` and `graphToSvg()` produce views from the same artifact. Overlapping same-kind memberships render one resource once, with additional membership annotations.

## Small modules

- `src/system`: capability builders, typed references, validation, recipes and intent views.
- `src/binding`: profile selection, support assessments, lowering and source mappings.
- `src/graph`: lower-level declaration, combinators, artifact validation, boundary rules and renderers.
- `src/execution/create-apply-chart.ts`: the single apply flowchart construction file.
- `src/execution/*-stages.ts`: small native stage functions.
- `src/execution/execute-operation.ts`, `persistence.ts`, `schedule.ts`: lifecycle, durable write ordering and bounded scheduling.
- `src/progress`: native deployment-event validation, live projection and subscribers.
- `src/synthesis/create-synthesis-chart.ts`: the dedicated native synthesis chart construction.
- `src/synthesis`: checked output recorders, native encodings, references and source mappings.
- `src/diagnostics/explain.ts`: structured read-only investigation.
- `integration/neo/graph.ts`: consumer composition.

Parallel result and progress publication uses one isolated scope adapter in `src/execution/scope.ts`, through the exactly pinned FootPrint 11.1.0 native recording funnel. The underlying `ScopeFacade.setGlobal` API is marked internal by FootPrint; upgrades require its provenance/replay tests. Each resource writes disjoint result/progress keys, while joins own shared failure state.

## Design

| Component | Responsibility |
| --- | --- |
| `Resource`, `Stack`, `ResourceAdapter` | Desired resources and explicit provider ports. |
| `buildPlan` | Refresh observed state; validate dependencies and ownership; choose create, update, verify, delete or no-op. |
| `InfraEngine` | Convert the ordered plan into FootPrint stages and explicit proceed/skip decisions. |
| `createDeploymentRecorder` | Project native resource progress into sequenced, run-scoped observations. |
| `synthesize`, output adapters | Record complete desired-resource compilation and finalize native files with source mappings. |
| `ReconcileStrategy` | Bound retries, stop on unknown observations, and require an adapter's safe-retry capability. |
| `FileStateStore` | Persist intent before effects, checkpoint inventory, and exclude concurrent local applies. |
| Foottrace | Replay recorded state and query recorded data/control dependencies. |

Resource dependencies govern execution order. Recorded data and control dependencies explain a particular execution. Execution defaults to sequential order. Set `maxConcurrency` to run bounded topological batches concurrently; started siblings settle before the next batch. Pruning stays sequential in reverse dependency order.

Adapters implement `observe`, `apply`, `remove` and `waitReady`. A target scope binds saved state to the configured provider target. A successful API send alone does not establish resource readiness.

## Recovery and lifecycle behavior

- Every operation writes and fsyncs its intent before any external effect. State checkpoints use atomic replacement and file/directory fsync. This store supports one machine, not distributed workers.
- Inventory records a pending create before sending it. If the process dies after creation, restart checks the provider, ownership and requested fingerprint, then accepts a matching resource without another apply. A regression test kills an actual child process at this boundary.
- Updates use safe **at-least-once** application. Reconciliation against a projection of newly declared fields cannot establish whether omitted old fields were removed. An interrupted update may be sent again through a safe adapter; it is not an exactly-once guarantee.
- A provider error triggers observation before retry. Unknown effects stop the run. Later batches are skipped after a terminal failure; started siblings settle and retain their outcomes. Successful resources remain in place; automatic rollback is not implemented.
- Removing a resource from the requested stack leaves it managed by default. `--prune` explicitly removes eligible absent resources in reverse dependency order. Resources with `lifecycle.retainOnRemoval: true` and their saved dependency closure remain managed; `Plan.retained` reports why. Protection survives omission and requires an explicit false policy followed by a successful apply to clear. Only resources with verified ownership are changed/deleted.
- `destroy STACK.json` removes saved owned resources. Kubernetes namespaces remain because deleting one cascades beyond framework inventory.
- Dead-PID locks are recoverable. Live, malformed, and incomplete locks fail closed. The state directory must be private to this framework instance and must not be shared across machines.

The state and evidence files contain declared resource data. They are local files with private permissions; callers own any further retention, redaction and access policy.

## Kubernetes

The adapter invokes the installed `kubectl` directly with an explicit context. In a shared process, pass `kubeconfig` explicitly; every command carries that selector without mutating the process environment. Credential file paths do not establish physical cluster identity; keep distinct state for distinct targets. It supports **Namespace, ConfigMap, Service and Deployment**, with verified ownership, atomic creation, conditional updates, delete preconditions and readiness checks.

Kubernetes distinguishes initial POST ownership from server-side apply ownership, even when the manager name is identical. Updates first use ordinary server-side apply. A bootstrap conflict can be retried with force only when the existing main-resource managers are exclusively this framework's, foreign status owners do not overlap the desired fields, and the original UID/resourceVersion preconditions still hold. Foreign ownership conflicts remain failures.

```sh
KUBECONFIG=.artifacts/kubeconfig npm run iac -- plan .artifacts/neo/stack.json \
  --context kind-footprint-iac-test --namespace footprint-iac-neo-test \
  --state-dir .artifacts/neo/state
```

Use `apply` after reviewing the plan. Context names bind state to a configured target; they do not authenticate that someone has not changed the API server behind that context. Use a separate state directory for another cluster.

The Kubernetes comparison projects live objects onto declared fields, ignoring server defaults. Lists remain positional and length-sensitive. Removing previously declared Kubernetes fields/list entries or renaming named list entries is explicitly rejected: initial POST field ownership can otherwise retain an omitted field. Automatic immutable-field replacement, Secrets, CRDs, imports/adoption and distributed state are outside this prototype. The simulator supports field removal for exercising the general planner.

## Neo AgentFootprint trial

The consumer app is the separate private [Neo AgentFootprint repository](https://github.com/sanjay1909/neo-agentfootprint). Its checkout is read-only for this integration. [`integration/neo`](integration/neo/README.md) snapshots the clean committed source, builds separate Node and Python images, and provides a Kubernetes binding plus a real health/UI/SQLite-tool smoke test. Default model replies remain the app's scripted fixture; no live collector or model credentials are configured.

```sh
npm ci
npm run check
npm test
npm run build
# Requires Docker, kind and kubectl; provide your own clean committed Neo checkout.
npm run neo:setup -- /absolute/path/to/neo-agentfootprint
```

The setup creates the dedicated local kind cluster `footprint-iac-review`, deploys through the high-level API and real Kubernetes binding, and leaves a loopback review server running. Read its actual URL and report in `.artifacts/neo/review/latest.json`; port15230 is preferred but may already be occupied. Follow the [sharing guide](docs/SHARING.md) for a pinned consumer checkout, prerequisites, expected checks and cleanup. Generated state, recordings, kubeconfig and app source are excluded from this repository.

## Evidence interpretation

Handled failures retain a full snapshot, execution tree, matching control lookup, decisions and narrative. The CLI also enables native streamed FootPrint records under the state directory's `traces` subdirectory; missing or failed capture is disclosed separately from durable operation control.

Native record completeness describes whether traversal was fully captured. Deployment success is separately reported by `ApplyResult.ok` and the recorded `failed`/`failure` state. A handled provider failure can therefore have a complete native traversal record.

Record replay reconstructs saved state. It does not execute an API request, recreate a cloud resource or roll anything back. Backwalking follows recorded candidate dependencies; it does not prove an external provider's internal root cause. A fresh reconciliation run gets a fresh execution record; cross-run causal stitching is not implemented.
