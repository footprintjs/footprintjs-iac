# Assess changes before choosing an execution path

`/change-assessment` exposes browser-safe report types and structural readers.
`/change-assessment/node` contains the read-only recorded workflow, private local
store, full report admission and declared-contract adapter. The optional
`/change-assessment/kubernetes` adapter validates actual API capabilities using
server dry-run. Resource assessment never calls `InfraEngine.apply`, provisions
a replacement, changes application routing or deletes anything.

Each registered change binds its previous/desired resources, adapter, strategy,
data classification, configuration digest and exact target scope. The workflow
records separate native stages for each resource's observation, capability
evidence, pure strategy choice, common safeguard admission and final decision.
It seals a report containing resource digests and measured decisions:

| Decision | Meaning |
| --- | --- |
| `noop` | The owned observed resource already matches the requested declaration. |
| `verify` | The declaration is present but readiness still needs verification. |
| `create` | An admitted absence permits planning a new resource. |
| `update` | The configured provider validation or declared contract permits this update. |
| `replace` | The configured validation establishes a replacement requirement. |
| `delete` | A removal is declared; a separate explicit removal/retention review remains necessary. |
| `blocked` | Ownership, destination, configuration, permissions or retention prevents proceeding. |
| `unknown` | The provider could not establish the capability or changed during observation. |

The result is a point-in-time assessment, not authorization or a guarantee of
later success. Executors must revalidate ownership, scope, source identity and
current version before effects. The existing resource engine remains
conservative about unsupported identity/field-removal changes. This module does
not insert an implicit delete-and-create action into that engine.

## Stable adapter and strategy ports

`ChangeAssessmentAdapter.probe` performs provider reads/validation.
`ChangeAssessmentStrategy.classify` is pure policy over those measured facts.
Common admission prevents a custom policy from manufacturing create/update or
convergence capabilities, adopting another resource's ownership, or recreating
a missing stateful source as though it contained no data. New provider tools
register adapters; new decision policies register strategies.

The `DeclaredContractAssessmentAdapter` is useful for internal tools and local
hosts with a known schema contract. It takes a trusted `observe` callback and
registered `mutablePaths` / `replacementPaths`, such as `/spec/schemaVersion`.
Unknown paths or drift remain unknown. A declared contract is labelled
`declared-contract`; it does not claim a server accepted a request.

```ts
import {
  ChangeAssessmentWorkflow, FileChangeAssessmentStore,
  conservativeChangeStrategy, DeclaredContractAssessmentAdapter,
} from 'footprint-iac/change-assessment/node';

const adapter = new DeclaredContractAssessmentAdapter({
  id: 'company-store', provider: 'company-store', scope: hostScope,
  mutablePaths: ['/spec/cacheSize'],
  replacementPaths: ['/spec/schemaVersion'],
  observe: readOwnedStore,
});
const workflow = new ChangeAssessmentWorkflow({
  definition: registeredDefinition,
  registry: { adapters: [adapter], strategies: [conservativeChangeStrategy()] },
  store: new FileChangeAssessmentStore(privateAttemptDirectory),
});
const assessment = await workflow.start();
// Admit a complete matching replace decision before composing MigrationWorkflow.
```

Each store holds one immutable assessment attempt. Completed reads validate
native replay and do not reissue provider probes. To reassess a changed system,
create another explicit attempt. Reports containing `unknown` or `blocked` do
not become executable migration plans just because a chart can be drawn.

## Kubernetes validation strategies

The built-in adapter supports the same four resource kinds as the existing
local provider: Namespace, ConfigMap, Service and Deployment. It verifies actual
framework ownership and UID/resourceVersion, validates the desired request, and
rechecks source identity/version afterward. Only structured immutable-field API
validation establishes replacement; a permission error, invalid configuration,
field-manager conflict or timeout is not replacement evidence.

The default `serverSideApplyValidation()` performs a dry-run with no force of
competing fields. `mergePatchValidation()` is an explicitly selected alternative
for an existing resource and adds `matching-update-executor` and
`field-ownership-review` requirements. There is no automatic fallback after an
SSA conflict. A merge-patch assessment does not imply an SSA executor can apply
the same change.

The explicit `ownedBootstrapServerSideApplyValidation()` strategy supports the
existing executor's one-time transition from its verified owned kubectl
bootstrap to SSA ownership. It uses the same shared bootstrap predicate as the
actual Kubernetes adapter. A force-enabled dry-run is admitted only when that
predicate establishes the exact owned bootstrap case and the strategy advertises
the matching executor requirement. It does not force competing owners generally
or retry a failed SSA check with another policy. The default strategy remains
non-forcing, and all assessment requests still require `dryRun=All`.

The host-only HTTPS transport verifies TLS, bounds response/payload sizes and
deadlines, and permits GET or PATCH with exactly `dryRun=All` on supported
resource object paths. Proxy/status subresources, persisted mutations,
duplicate dry-run parameters and redirects are refused. Credentials and API
body values stay in the host; another trusted transport can supply a different
authentication mechanism while retaining the adapter's dry-run contract.
These semantics follow the official [Kubernetes dry-run API](https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run)
and [update/version preconditions](https://kubernetes.io/docs/reference/using-api/api-concepts/#updates-to-existing-resources).

## Stateful replacement

A stateful `replace` decision lists the required writer fence, verified backup,
data validation, explicit cutover and retained original. Unknown data needs
classification first. The separate [migration workflow](migration.md) and
[real SQLite adapter](sqlite-migration.md) implement the next lifecycle. Its
checkpoint must still prove the original identity, snapshot, fence, backup,
candidate and verification when the human resumes.

Native recordings contain safe labels, reason codes, configured schema paths
and digests. They exclude raw resource values, connection endpoints, provider
error bodies and data rows. Keep private state/evidence directories outside any
web root. The Lens host projects these reports and measured migration phases;
it cannot accept SQL, paths, endpoints, commands or provider instances from the
browser.

## Backwalk before deployment

For a registered change `store`, native state contains the separately written
`observation:store`, `capability:store`, `classification:store`,
`admission:store` and `decision:store` values. Each following stage consumes its
recorded inputs through `ScopeFacade`, retaining per-write dependency evidence.
A read-only dependency query on `decision:store` can follow the decision to its
policy choice, common ownership/capability guard and provider evidence writers.
An optimistic custom strategy that asks to update an unknown provider capability
is visibly overridden by the common admission stage; the reason is recorded
before any deployment effect. An unavailable provider observation has an
explicit `available: false` observation fact and remains `unknown`.

The adapter's existing `probe` is still one trusted read-only measurement/validation
call. The observation and capability stages separately project that returned
evidence; they do not claim two independent provider calls. Private physical
handles and resource values remain in the host. Their digests bind the public
facts to that private measurement while preserving custom adapter/strategy
contracts. Strategy code is trusted pure host registration; the recorder does
not discover uninstrumented external reads inside it or prove a provider's
physical root cause. Reopening completed evidence does not invoke the provider
or run policy again.
