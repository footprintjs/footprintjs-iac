# FootPrintJS IaC — InfraChart

**Define infrastructure as a graph. Deploy, observe and explain every change.**

A TypeScript infrastructure framework built on **FootPrint 12.1.0** and **Foottrace 1.15.0**. Alpha version **0.5.0-alpha.2** describes compute, storage and network before selecting implementations. A binding profile expands that intent into a resource graph; the engine plans changes, records reconciliation, recovers uncertain creates and supports saved replay/backwalk. Native recorders also drive live deployment progress and checked output generation.

`footprintjs-iac` is the package name; **InfraChart** is its display name. This is an early alpha: public APIs may change between prereleases. Existing state directories, Kubernetes ownership annotations and field-manager names, local fixture image references and systemd markers retain their original `footprint-iac` identifiers so the naming change preserves recorded resource ownership.

This is an executable prototype with a simulator, a Kubernetes adapter and recorded native artifact generation. The separate [InfraChart Lens](https://github.com/footprintjs/footprintjs-iac-lens) supplies a live system view and Flow Lens evidence inspection. This remains a single-machine foundation, not a production deployment service.

Start with the [capability and wrapper guide](docs/CAPABILITIES.md). The [identity and permission guide](docs/IDENTITY.md) covers generic access policies, recorded authorization and the LDAP adapters. See [VALIDATION.md](VALIDATION.md) for current checks and the earlier completed real Neo Kubernetes trial. The [design notes](docs/DESIGN.md) define graph semantics and implementation boundaries.

For another laptop, start with the [clone, setup and test guide](docs/SHARING.md). The [agent handoff](docs/NEO-AGENT-HANDOFF.md) is ready to forward with the repository link. The library repository is public; the separate Neo source repository requires GitHub read access.

The [reusable onboarding preset](src/onboarding/README.md) composes Discover →
Configure → Verify → Review → Deploy over a registered deployment strategy.
CLI and Lens can share the same target, check policy and native controller
ledger. Application-specific login, access and dependency adapters stay in the
consumer. [Agent guidance](docs/agent-onboarding.md) and a
[source-linked workflow map](docs/onboarding/README.md) explain where to change
each part and how to verify it. Onboarding is in this source candidate; the
previous npm alpha does not contain these exports.

For setup changes, the optional [version registry](src/onboarding-versions/README.md)
records a configuration diff before explicit activation. Versions keep one
physical owner and native deployment ledger. A new version starts pending;
the existing planner then assesses and deploys only the affected resources.
Pending owners block the switch, while an exact no-op preserves the current
head and Ready run. Activation itself performs no resource deployment.

The host-only [platform bootstrap API](docs/platform-bootstrap.md) separates server
access/discovery, installation strategies and cluster lifecycle adapters. It
records Create/Find → connection publication → Connect → Verify, including
per-action preflight, durable intent and human pause/resume. Pinned local/SSH
transports and kubeadm/existing-cluster adapters keep installer tools outside the
core workflow. The [workload adapter](docs/kubernetes-workload.md) then deploys
application containers into the registered cluster.

## Install the alpha

Requires Node.js 24 or newer. Pin the preview version
when adopting it in an application:

The `0.5.0-alpha.2` source candidate has not been published to npm. Build and
pack this checkout (`npm ci`, `npm run check`, `npm test`, `npm run build`,
`npm pack`), then install the resulting archive in the consuming project.
Neo and Lens pin a reviewed archive with its hash, so another laptop needs no
developer-local source paths. Use their lockfiles with `npm ci`.

The `alpha` distribution tag installs the previously published preview
(`npm install footprintjs-iac@alpha`); it does not imply this checkout's new
APIs are available in the registry.
Use public package exports such as `footprintjs-iac`,
`footprintjs-iac/deployment-strategy` and `footprintjs-iac/master/workflow`.
Importing the library performs no deployment. Providers, private connection profiles,
secret stores and rollout policy are registered by the consuming host.

See [CHANGELOG.md](CHANGELOG.md) for this release. The separate
`footprintjs-iac-lens` package provides the optional dashboard; the core has no React dependency.

## Capability API

Release delivery has separate interfaces for source catalogs, build/publication,
rollout strategies, effect adapters, check runners and trigger/storage adapters.
Build once into a sealed manifest, then promote the same content through
host-configured environments. Native recordings retain real rollout, approval,
acceptance and verified application recovery outcomes. See the [release guide](docs/releases.md),
[strategy contracts](docs/release-strategies.md), and [checks and triggers](docs/checks-and-triggers.md).
Neo composes these contracts in its [local release consumer](integration/identity/release-pipeline/README.md);
its current adapter supports direct application updates with rollback disabled.
The [Neo release automation consumer](integration/identity/release-automation/README.md)
adds manual Lens initiation and host-driven discovery of new published versions.
It builds one exact source revision and promotes the same artifacts through
registered dev, gamma and prod targets. Normal Neo release plans now run
mandatory recorded provider preflight and revalidate before apply; unsupported,
replacement or unknown changes stop before the candidate is applied. FootPrint
records observation, capability evidence, strategy choice, common safeguards and
the decision as separate backwalkable stages. See [generic automation](docs/release-automation.md)
and the sibling Lens guide `docs/neo-release-automation.md` for host setup.
Database migration and automatic resource replacement are not inferred by resource reconciliation.
The separate opt-in [change assessment](docs/change-assessment.md) workflow records
provider validation before selecting an execution path. [Guarded migration](docs/migration.md)
adds explicit write fencing, backup/data verification and human cutover gates.
Its [local SQLite adapter](docs/sqlite-migration.md) exercises real record transfer
with a cooperating single-host consumer; it does not migrate Neo's current data.

```ts
import { system, artifact, ref } from 'footprintjs-iac/system';
import { bindSystem, simulationProfile } from 'footprintjs-iac/binding';

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

`npm run build` produces the importable library in `dist/src`. npm releases include compiled JavaScript, TypeScript declarations, source and integration guides.

## Versioned master workflow

A master revision saves the desired graph, source/artifact identities and its
parent revision as immutable JSON. Its revision ID, JSON schema version and
native deployment run ID have separate meanings. The Node host supplies the
engine, provider credentials, durable stores and target binding:

```ts
import { infra, resource, InfraEngine, FileStateStore, SimulatorAdapter } from 'footprintjs-iac';
import { createDeploymentRecorder } from 'footprintjs-iac/progress';
import { defineSystemRevision, FileMasterStore, MasterWorkflow } from 'footprintjs-iac/master/workflow';

const graph = (image: string) => infra('master-example')
  .start(resource('app', 'simulator', { image })).synth();
const progress = createDeploymentRecorder();
const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.artifacts/master-example/resources'),
  recorders: [progress], chartObservers: [progress],
});
const target = { id: 'local-example', scope: 'simulator:owned-local-system' };
const master = new MasterWorkflow({ engine, target,
  store: new FileMasterStore('.artifacts/master-example/history') });
const v1 = defineSystemRevision({ revisionId: 'v1', parentDigest: null, target, graph: graph('example:v1') });

// One-time baseline: an existing deployment supplies its complete native ApplyResult.
const baseline = await engine.apply(v1.graph); // This example creates a simulated baseline.
await master.adopt(v1, baseline); // Also requires a current all-noop, ready plan.
const v2 = defineSystemRevision({ revisionId: 'v2', parentDigest: v1.digest, target, graph: graph('example:v2') });
await master.stage(v2, { expectedAppliedDigest: v1.digest });
const review = await master.preview();
console.log(review.changes, review.plan.operations); // Inspect declaration differences and actual actions.
const result = await master.apply(review.reviewId);
console.log(result.runId, (await master.getState()).appliedDigest);
```

Stage and preview do not mutate provider resources. Preview seals the exact
operation plan, including current observations; apply checks it again under the
engine's state lock. A changed head, candidate or observed plan requires another
review. A reviewed no-op cannot silently become a repair during execution.
Only resources whose admitted plan needs a change are mutated; unchanged
resources still receive recorded readiness checks. Promotion requires matching,
complete native evidence. A failed attempt retains the previous applied revision
and any successful partial provider effects remain visible for the next review.

Reuse the same target binding, resource IDs, provider scope and resource state
store for an upgrade. A revision cannot switch the workflow's target or stack;
JSON does not select credentials or executable adapters. Adding or updating
resources follows the provider's supported semantics. Removing a declared
resource requires an explicit `master.preview({ prune: true })` review before
apply; ownership and retention policies still protect resources. Removing
individual Kubernetes fields remains unsupported, as described below.

An interrupted process can leave an unresolved `running` master attempt. Further
changes stay blocked until its outcome is resolved; this prototype does not yet
provide a crash-recovery API. Do not treat an interrupted attempt as a successful
upgrade or start another history to bypass it.

## Create or find, then connect and verify

The base resource workflow records four actual native stages:

```text
Create resource / Find existing → Connection details → Connect application → Verify connection and access
```

Resource acquisition and application integration are separate tasks. In
`create` mode the host's provisioner creates or reconciles the source. In
`existing` mode only the read-only lookup runs; a missing source fails and never
falls back to creation. Both return the same public `ResourceHandle`, so the
connection and verification stages work with either source. Company service
catalogs, cloud providers, on-premises services and manual provisioning can
supply this contract. The source resource ID is distinct from the workflow ID.

```ts
import type { ResourceFlowAdapters } from 'footprintjs-iac/resource-flow';
import { FileResourceFlowStore, ResourceFlowWorkflow } from 'footprintjs-iac/resource-flow/workflow';

function companyHistoryConnection(adapters: ResourceFlowAdapters, configurationDigest: string) {
  return new ResourceFlowWorkflow({
    definition: {
      id: 'application-history-connection', resourceId: 'company-history',
      label: 'Connect application history', mode: 'existing',
      target: { id: 'office-environment', scope: 'owned-target-and-resource-selection' },
      configurationDigest, // SHA-256 of the reviewed host-selected consumer configuration.
    },
    profiles: [{ id: 'office-history', label: 'Office history database' }],
    store: new FileResourceFlowStore('.artifacts/company-history-connection'),
    adapters,
  });
}
// await workflow.start();
// const paused = await workflow.snapshot();
// await workflow.resume({ pauseToken: paused.pause!.token, profileId: 'office-history' });
```

The host supplies small `create`, `find`, `resolveDetails`, `validate`, `connect`
and `verify` adapters. `create` is optional in existing mode. Connection details
contain the selected profile ID, resource ID, credential-free endpoint URL,
protocol and optional credential/trust references. A real create's unknown
endpoint can be resolved afterward through provider observation. The same
details resolver can read a company profile without provisioning anything.
`connect` configures the authorized consumer, routes or permissions; `verify`
returns measured, individually identified outcomes. A successful configuration
call does not imply successful communication or access.

If automatic details are unavailable, the details stage calls FootPrint's real
`interrupt`. The native checkpoint, completed acquisition and exact pending
profile choices are durably retained. No lock stays held during a human wait.
The browser can select only a configured opaque profile ID and echo its exact
one-use pause token; it cannot send credentials, an endpoint, a target or code.
Resolve credentials privately behind the adapter. Checkpoints contain actual
shared state, so recording redaction is not a password-storage mechanism.

A fresh workflow process can resume the same ledger. Definition, source,
configuration, target, profile catalog and checkpoint must still match. Lookup
and validation re-observe the same physical resource before connection. Resume
starts at the details stage and does not repeat a completed create. Each native
leg has its own run ID and evidence/JSONL file, with an explicit link to the
paused leg; this is not a fabricated single uninterrupted run. Resource and
connection receipts can link the child deployment and probe recordings.

Use `ResourceFlowAdapterError(code, receipt)` for a failed child operation that
already has native evidence. The workflow records its bounded code and receipt;
arbitrary provider exceptions are replaced with a fixed public failure before
FootPrint sees them. Trusted adapters must return only public references and
measurements. Failed verification remains failed, and incomplete capture never
reports a passed workflow. An interrupted effectful process retains its running
intent and blocks a fresh start; inspect/reconcile its private outcomes rather
than copying the ledger or replaying a create blindly. Existing engine ownership
and master revision guards are unchanged. This workflow does not import an
externally owned source into infrastructure management.

The pure `footprintjs-iac/resource-flow` export provides JSON types and the bounded
`readResourceFlowState` reader for headless clients. Node orchestration lives in
the separate `/workflow` export. Subscribers receive provider/recorder-driven
state changes, including waiting, failure and partial outcomes; there are no
display timers or fake create events for referenced infrastructure.

For the complete portable Neo Create/Find/human-resume acceptance setup, use the
[resource workflow laptop handoff](docs/NEO-RESOURCE-FLOW-HANDOFF.md). It is separate
from the older one-build and master-upgrade examples.

## Recorded native outputs

With a Kubernetes-bound design, export the complete desired graph through native output recorders:

```ts
import { synthesize, kubernetesOutput } from 'footprintjs-iac/synthesis';

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

## Live progress and InfraChart Lens

Attach the existing native recorder extension to an engine:

```ts
import { InfraEngine, FileStateStore, SimulatorAdapter } from 'footprintjs-iac';
import { createDeploymentRecorder } from 'footprintjs-iac/progress';

const progress = createDeploymentRecorder();
const stop = progress.subscribe(event => {
  console.log(event.resourceId, event.status, event.action);
});
const stopChart = progress.subscribeChart(chart => {
  // Translate the actual native chart; resource bindings identify its execute/skip/gate stages.
  console.log(chart.structure, chart.resources);
});
const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.artifacts/progress-example'),
  recorders: [progress],
  chartObservers: [progress],
});
try { await engine.apply(binding.graph); }
finally { stop(); stopChart(); }
```

This example uses a simulation binding; provide the matching provider adapter for a real binding. Progress comes from recorded stages: `pending`, `deploying`, `ready`, `failed`, `skipped` and `deleted`. Ready follows provider confirmation, including on a no-op; a timer or successful API send does not make a node ready. New saved apply evidence includes its native build-time `structure` alongside the snapshot, decisions and narrative.

The explicit IaC `chartObservers` bridge publishes the unchanged native
`buildTimeStructure`, run/graph identity and resource-stage bindings after
recorders reset and before traversal starts. It preserves the engine's actual
serial gates or bounded parallel selector/join batches. The topology describes
scheduled work; only runtime events establish that work started or became ready.
`getSnapshot().chart` and saved `deploymentChart` retain the same native topology.
This bridge uses FootPrint's existing `onRunStart` lifecycle; it does not add an
`onBuild` hook to `CombinedRecorder` or introduce another workflow engine.

A host can prepare stable grey-node positions before execution using the same
native chart constructor:

```ts
import { previewDeploymentChart } from 'footprintjs-iac/progress/preview';
import { readDeploymentSchedulePreview } from 'footprintjs-iac/progress';

const plan = await engine.plan(binding.graph); // Separate read-only provider observations.
const preview = previewDeploymentChart(plan, {
  graphDigest: binding.graph.digest,
  maxConcurrency: 1, // Match the engine's configured limit.
});
const admittedPreview = readDeploymentSchedulePreview(preview);
```

The factory is Node-side; the reader and `DeploymentSchedulePreview` type are
browser-safe. The tagged preview contains no run ID, events or readiness verdict.
It only describes the supplied plan's native schedule. Apply still replans, and
its actual native chart takes precedence when published; recorded events alone
advance resource progress.

The independently versioned [footprintjs-iac-lens](https://github.com/footprintjs/footprintjs-iac-lens) repository supplies the separate dashboard. Its root and `/core` APIs expose TypeScript models and transport without React imports; `/react` provides the optional React surface using Flow Lens. The resource system chart and native execution chart are separate views: infrastructure relationships describe the system, while the execution recording shows what this run did. See [PROGRESS.md](docs/PROGRESS.md) for recorder usage, status semantics and the UI boundary.

Connection checks run in a separate native FootPrint chart, after resources are ready:

```ts
import { checkConnections, createConnectionRecorder, KubernetesConnectionAdapter } from 'footprintjs-iac/connections';

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

## Identity and permissions

Identity sources and access policies are generic crosscutting declarations. Provider adapters supply authentication and directory integration:

```ts
import { defineIdentitySource, defineAccessPolicy, authorizeAccess } from 'footprintjs-iac/identity';

const source = defineIdentitySource({ id: 'company-directory', kind: 'directory' });
// ownership defaults to 'external'; this reference does not create or own the directory.
const policy = defineAccessPolicy({ id: 'application-access', rules: [{
  id: 'readers', effect: 'allow', source: source.id, groups: ['application-readers'],
  actions: ['application:read'], resources: ['application'],
}] });

// subject comes from a trusted authentication adapter, never an unverified request body.
const authorization = await authorizeAccess({ policy, subject,
  action: 'application:read', resource: 'application', traceDirectory: privateTraceDirectory });
// The host must enforce authorization.decision.effect before serving protected data.
```

A rule matches `source AND (subject OR group) AND action AND resource`, using exact values. Unmatched requests are denied; a matching explicit deny overrides every allow. `evaluateAccess` is the pure evaluator, also available through the Node-free `footprintjs-iac/identity/policy` export. `authorizeAccess` evaluates the same policy in a native FootPrint workflow, recording safe identity, policy and request inputs plus the allowed/denied branch. Neither function authenticates a caller or enforces a decision on its own.

`footprintjs-iac/identity/ldap` supplies a real `LdapSourceAdapter` for bounded LDAPS authentication/group lookup and a separate pure `LdapIdentityAdapter` for LDAP-to-Keycloak federation configuration. Both keep LDAP-specific choices outside the generic policy API. Secret resolvers/references supply credentials at runtime; do not put passwords, tokens or signing keys in graph JSON or diagnostic metadata.

`checkIdentityAccess` runs declared login/access/directory checks through a trusted observation adapter. Native `checking`, `passed` and `failed` events drive Lens's identity panel. An expected denial passes only when the adapter observes denial; an unavailable identity backend is a separate failed observation. Identity checks preserve their own recording and do not change a successful infrastructure deployment into a failed resource run.

The [local Neo identity integration](integration/identity/README.md) composes an isolated directory fixture, identity provider and real Neo app. Its permission boundary is currently app-wide `neo:chat` access to `neo`; it does not implement tool-specific IAM, Kubernetes RBAC or production SSO guarantees. Existing security/role boundaries and capability `runAs` declarations remain descriptive unless a supported adapter explicitly implements them. See [IDENTITY.md](docs/IDENTITY.md) for evidence interpretation and limits.

## Lower-level resource graph API

```ts
import {
  infra, resource, graphToMermaid,
  InfraEngine, FileStateStore, SimulatorAdapter,
} from 'footprintjs-iac';

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

## Select a deployment strategy

`footprintjs-iac/deployment-strategy` provides one registered controller interface:
`plan({revisionId})`, `apply(reviewId)` and `snapshot()`. A host registers adapters
and selects an ID through `DeploymentStrategyRegistry`; customer data selects an
existing registration rather than supplying commands, credentials or code.

The Kubernetes adapter wraps an existing guarded controller. The systemd adapter
uses the same InfraEngine, Master and recorded checks over registered installed
services. Coupled services use one systemd transaction so native `Requires` and
`After` dependencies retain their meaning. Plans bind actual machine and service
facts, are revalidated before effects, and require application checks before
promotion. Unchanged services are no-ops.

The generic systemd host supports a bounded local process runner or a privately
registered SSH/API runner. Neo and other applications supply their own service
bindings, release/configuration digests and measured acceptance policy. Selecting
a strategy does not migrate data or move application traffic. See
[deployment strategy contracts and examples](docs/deployment-strategies.md).

## Small modules

- `src/system`: capability builders, typed references, validation, recipes and intent views.
- `src/binding`: profile selection, support assessments, lowering and source mappings.
- `src/graph`: lower-level declaration, combinators, artifact validation, boundary rules and renderers.
- `src/execution/create-apply-chart.ts`: the single apply flowchart construction file.
- `src/execution/*-stages.ts`: small native stage functions.
- `src/execution/execute-operation.ts`, `persistence.ts`, `schedule.ts`: lifecycle, durable write ordering and bounded scheduling.
- `src/progress`: native deployment-event validation, live projection and subscribers.
- `src/identity`: generic sources, exact permission policies and native authorization/check workflows.
- `src/identity-ldap`: strict LDAPS authentication and pure LDAP federation binding.
- `src/change-assessment`: read-only provider probes, classification strategies and sealed reports.
- `src/migration`: opt-in protected replacement stages, durable checkpoints and manual gates.
- `src/migration-sqlite`: the separate owned local SQLite adapter and cooperating consumer.
- `src/synthesis/create-synthesis-chart.ts`: the dedicated native synthesis chart construction.
- `src/synthesis`: checked output recorders, native encodings, references and source mappings.
- `src/diagnostics/explain.ts`: structured read-only investigation.
- `integration/neo/graph.ts`: consumer composition.
- `integration/identity`: separate local directory/provider/Neo acceptance fixture.

Parallel result and progress publication uses one isolated scope adapter in `src/execution/scope.ts`, through the exactly pinned FootPrint 11.1.0 native recording funnel. The underlying `ScopeFacade.setGlobal` API is marked internal by FootPrint; upgrades require its provenance/replay tests. Each resource writes disjoint result/progress keys, while joins own shared failure state.

## Design

| Component | Responsibility |
| --- | --- |
| `Resource`, `Stack`, `ResourceAdapter` | Desired resources and explicit provider ports. |
| `buildPlan` | Refresh observed state; validate dependencies and ownership; choose create, update, verify, delete or no-op. |
| `InfraEngine` | Convert the ordered plan into FootPrint stages and explicit proceed/skip decisions. |
| `createDeploymentRecorder` | Project native resource progress into sequenced, run-scoped observations. |
| Identity adapters and access policies | Establish verified subjects through supported adapters and derive explicit permission decisions; hosts enforce those decisions. |
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

The base [connection profile API](docs/connection-profiles.md) accepts adapter-declared connection settings and keeps credentials behind a pluggable secret store. Saved immutable profile IDs can be selected before Find and retained across native human pause/resume. Memory and encrypted local-file adapters are included; a host can supply its own approved secret backend.

The [Neo existing-system example](docs/neo-existing-connections.md) consumes this API. InfraChart Lens renders its declared connection form and tests the supplied details against the real existing local identity service. The generic registry, workflow and form contain no Neo-specific switches.

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

## License

[MIT](LICENSE).
