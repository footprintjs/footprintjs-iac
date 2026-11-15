# Select a deployment strategy

The library exposes one controller interface for registered deployment adapters:

```ts
interface DeploymentStrategyAdapter {
  readonly id: string;
  readonly kind: string;
  plan(input: { revisionId: string }): Promise<{ ok: boolean; reviewId?: string }>;
  apply(reviewId: string): Promise<{ ok: boolean; promoted: boolean; status: string }>;
  snapshot(): Promise<unknown>;
}
```

`DeploymentStrategyRegistry({ adapters })` captures trusted controllers. `list()`
returns their public IDs/kinds; `select(id)` returns exactly the registered
controller or refuses. It never falls back to a different host, strategy or
provider. Construction and registry selection perform no provider calls.

```ts
import {
  DeploymentStrategyRegistry,
  createKubernetesDeploymentAdapter,
  createSystemdDeploymentAdapter,
} from 'footprintjs-iac/deployment-strategy';

const registry = new DeploymentStrategyRegistry({ adapters: [
  createKubernetesDeploymentAdapter({ id: 'kubernetes', controller: guardedWorkloadController }),
  createSystemdDeploymentAdapter(registeredSystemdHost),
] });
const selected = registry.select(customerChoice);
const review = await selected.plan({ revisionId: 'application-release-12' });
if (review.ok) {
  // Display the concrete review before this explicit operator/policy decision.
  const outcome = await selected.apply(review.reviewId!);
  // Only outcome.promoted === true establishes application acceptance.
}
```

The customer choice is an adapter ID. Commands, host callbacks, credentials,
state paths and installed unit bindings remain trusted host registrations. New
provider kinds implement this interface without changing a central two-kind
switch. The pre-existing Delivery `DeploymentAdapter` and Pipeline
`RolloutAdapter` remain lower-level publication/rollout ports; this controller
adds manual reviewed plan/apply selection without replacing either workflow.

## Kubernetes

`createKubernetesDeploymentAdapter({ id, controller })` bridges an existing
controller's `plan`, `apply` and `snapshot` methods. It preserves that controller's
sealed review, actual target fences, provider compatibility assessment, Master
history, recording and post-deployment application checks. The bridge adds no
second engine and does not make an unguarded callback safe. Register a controller
that pins the endpoint, CA and namespace UID, rather than a context name alone.
See [Kubernetes workload adapters](kubernetes-workload.md).

## Systemd

`createSystemdDeploymentAdapter` composes the existing InfraEngine,
MasterWorkflow and native CheckWorkflow. It manages an explicitly registered set
of already installed services. It does not install packages, create arbitrary
unit files, remove units, move data, or switch production traffic automatically.
A site's approved preparation/build gate must finish before this controller
reviews a running-service update.

Required options:

- `id`, `stack`, private absolute `stateDirectory`, and immutable `releaseDigest`.
- `registration: { hostId, scope, identityDigest }`, with a measured stable
  machine identity hash.
- `units: [{ id, name, fragmentPath, configurationDigest }]`. Names must be
  explicit `.service` units; fragment paths are absolute. The configuration
  digest commits the approved effective startup configuration, including static
  drop-ins and relevant environment-file bytes, while excluding only the
  deployment adapter's own release marker. No configuration values enter the
  graph or recorder.
- `host: { inspect, applyUnits }` by default. This private port may use local,
  pinned SSH, or another approved host transport. It measures the actual machine,
  unit configuration, active invocation and current process marker. The graph
  contains no scripts or credentials.
- `preflightChecks` and `applicationChecks`, each
  `{ runner, suiteId, requiredCheckIds }`, using registered native CheckRunner
  suites. Required results are projected to known IDs/statuses. Private reports,
  raw provider diagnostics and unknown result fields are omitted.

Optional `source: { repository, commit, tree }` and
`artifacts: [{ id, digest, reference }]` retain non-secret package provenance in
each sealed Master revision and its applied history. The controller validates
and detaches these fields at construction, before target observation, using the
same Master readers as Kubernetes and other revision producers. Repository URLs
and artifact references must be credential-free; private checkout/package paths
stay in the host adapter. Changing this provenance requires a new review even
when the resource graph is unchanged. These fields explain the selected source
and package; an application check still has to measure that the expected package
is actually running.

The default `transaction: 'group'` declares one `SystemdServiceGroup` resource.
Its `units` member list is a group, not a fabricated serial deployment order.
`host.applyUnits({ units, desiredSpecDigest, releaseDigest }, context)` must
perform one fixed systemd transaction over exactly those units. Systemd owns
`Requires`/`After` ordering. This prevents a legitimate dependency restart from
silently invalidating or bypassing a later per-unit review permit.

The context contains `operationId`, `expectedIdentityDigest` and
`expectedUnits`. The host must recheck them immediately before its effect. The
controller independently repeats the same checks. Every active process must
report the same `desiredSpecDigest` after the transaction, measured from a
private runtime marker rather than copied from the desired request. A marker
without the actual expected unit/host/configuration and active process is not
convergence evidence.

`transaction: 'independent'` is available only for services whose lifecycle
truly is independent. It declares one resource per unit and calls
`host.applyUnit({ unit, desiredSpecDigest, releaseDigest }, context)`. Optional
unit `dependsOn` controls engine ordering in this mode. Do not use it to hide
systemd dependency side effects or ignore dependencies. Units with coupled
restart semantics belong in the default group transaction.

An observation is:

```ts
{
  identityDigest,
  units: [{
    name, exists, fragmentPath, fragmentDigest, configurationDigest,
    activeState, invocationId, appliedSpecDigest,
  }],
}
```

`fragmentDigest` measures the literal unit fragment; `configurationDigest`
measures the effective approved configuration. `appliedSpecDigest` comes from
the active service process and is null when no version has been established.
Missing units, unknown observations, host/configuration drift and stale
invocations stop before service effects. Source, dependency and application
acceptance are site-owned suites, because they differ by application.

## Review, recovery and history

Plan performs real target and preflight checks, stages a versioned Master
revision, then returns a sealed review. Apply durably consumes that review before
fresh checks. It compares the same machine/unit observations, approved check
contracts and exact engine plan, then delegates to Master/InfraEngine. The engine
records resource intent before provider effects. A provider permit is one-use;
an uncertain service operation cannot automatically retry.

Application acceptance is separate from infrastructure readiness. A known
infrastructure success may advance the applied Master revision while remaining
unpromoted if application checks fail. Correct the cause and make a new explicit
review. An unfinished or unknown service effect remains `incomplete` and requires
inspection rather than a guessed restart.

Changing an approved configuration digest or release produces a new revision
on the same physical host/units and ledger. It does not change ownership identity.
Changing host identity, unit membership, fragment locations or transaction mode
requires a separately registered target/controller rather than silently reusing
saved intent. Cross-strategy traffic/data migration needs its own reviewed flow.

`snapshot()` reads retained state and verifies promoted engine and application
outcomes against their exact Master review, physical target, suite, native
recording and complete trace. It invokes no provider or acceptance callback.
The stores are single-controller local files; multi-controller operation needs
transactional shared storage and locking.

Focused tests run with `node --test test/deployment-strategy.test.ts`. They cover
registry selection, the Kubernetes bridge, grouped and independent systemd
updates, no-op, fresh failure/drift fences, one-use review, uncertain effects,
configuration-only revisions, check-contract races and foreign/tampered native
receipts. Controlled ports prove those contracts; a real systemd/Kubernetes
acceptance run separately establishes the selected site's actual behavior.


## Native progress in a viewer

The systemd controller accepts the same optional native observer ports as
`InfraEngine`. Register one deployment recorder in both `recorders` and
`chartObservers` to receive actual resource progress and the executed chart:

```ts
const recorder = createDeploymentRecorder();
const controller = createSystemdDeploymentAdapter({
  ...registeredSystemdOptions,
  recorders: [recorder],
  chartObservers: [recorder],
});
```

These observation ports do not grant deployment authority or change the sealed
review. Planning emits no resource deployment progress. Resource readiness
follows the provider's native apply/verification result; application promotion
still requires the separately registered checks.
