# Reviewed onboarding versions

Use this optional module when desired setup changes over time. The existing
onboarding workflow and deployment strategy still own discovery, verification,
resource planning and deployment. This registry owns the reviewed choice of
desired configuration for one stable deployment owner.

Pure types and readers are exported from `footprintjs-iac/onboarding/versions`.
The durable Node implementation is exported from
`footprintjs-iac/onboarding/versions/node`:

```js
import { OnboardingVersionRegistry } from 'footprintjs-iac/onboarding/versions/node';

const registry = new OnboardingVersionRegistry({
  id: site.registryId, label: site.label, directory: site.registryDirectory,
  owner: site.stableOwner, initialVersionId: 'setup-v1',
  versions: site.registeredVersions,
  guard: site.ownershipGuard,
});

const review = await registry.dispatch({ action: 'review-version', versionId: 'setup-v2' });
// Present review.review.changes, blockers and native recording to the operator.
const activated = await registry.dispatch({
  action: 'activate-version', reviewId: review.review.reviewId,
});
// activated.active is pending. Deployment still uses the normal reviewed flow.
```

`stableOwner` pins the strategy, target, physical registration and native
controller identity. Desired release, profile, unit configuration and check
digests belong to version registrations, rather than that stable identity.
Each version registers a pure `createPreset(context)` factory. Use its supplied
session/workflow paths and `context.withActiveVersion` around deployment effects;
retain the same native controller directory for every version. Register legacy
paths explicitly through `legacy`; missing owner files do not authorize adopting
an existing ready workflow or creating a new ledger around uncertain effects.

The ownership guard must lock the real participating host and native stores,
then inspect every requested original owner, including the candidate. The
registry locks its own ledger and original workflow stores first. Host/native
guards must use a consistent lock order and avoid reacquiring these locks.
A pending host intent blocks transfer even when a separate native receipt says
the deployment succeeded. Missing or unreadable evidence stays unknown.
Registered observations describe their own scope; replaying retained ownership
is not a live hardware-health check. The normal provider preflight remains
mandatory before resource effects.

Expose `registry.activeWorkflow` to viewers, rather than a retained version's
raw workflow. Exported CLI adapters also use
`registry.withActiveVersion(versionId, work, expectedHead)` across native
operations. Private asynchronous leases expire when their operation ends;
late callbacks cannot retain authority. Quiesce old unversioned controllers
when enrolling: code that does not participate in these locks/fences remains
an external control boundary, as does a direct provider command.

`snapshot()` returns the active workflow, head, review and version history in
one envelope. `recording()` re-admits native evidence without calling providers.
The native chart is **Bind → Inspect all original owners → Decide transition**,
constructed in `create-version-chart.ts`. A head advances only after complete
capture is admitted and durably saved. Missing capture retains the old head and
requires the exact `reconcile-activation` action; reconciliation records a failed
closure without deploying or advancing the head. Original uncertain deployment
effects use their separate registered observation-only reconciliation first.

Exact no-ops record the decision while preserving the current head, workflow
run and readiness. Retired version IDs cannot borrow an old green workflow;
register a fresh ID with the desired old configuration for a reviewed rollback.
This is configuration selection, not automatic data migration or resource
replacement. Versions, operations and retained history have explicit bounds in
the public types and implementation; preserve/archive evidence before reaching
those limits rather than deleting owner files.

See `test/onboarding-versions.test.ts` and the generated
[source map](../../docs/onboarding/README.md) for the executable admission and
recovery contracts. Native captures establish recorded observations; opaque
adapter internals require their own measured evidence for deeper backwalk.
