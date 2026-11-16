# Reusable application onboarding

This module composes registered observation adapters and an existing deployment
strategy. It contains no Neo, LDAP, systemd installer or Kubernetes assumptions.
A consumer selects one immutable registered target and supplies its private host,
connection and application check adapters. CLI and Lens should use the same
composition and the same deployment controller directory.

```ts
import { createOnboardingPreset } from 'footprintjs-iac/onboarding';
import { OnboardingWorkflow } from 'footprintjs-iac/onboarding/node';

const preset = createOnboardingPreset({
  definition: {
    version: 1, id: 'company-app', label: 'Company application',
    strategyId: deployment.id, targetId: 'existing-server',
    configurationDigest, // covers private configuration and adapter contracts
  },
  deployment, // existing registered DeploymentStrategyAdapter
  adapters: { discover, configure, verify },
  projectReview, // pure safe resource/action projection of the native review
  projectDeployment, // optional pure safe projection of measured application checks
});
const onboarding = new OnboardingWorkflow({ preset, directory: privateDirectory });
await onboarding.dispatch({ action: 'discover' });
await onboarding.dispatch({ action: 'configure' });
await onboarding.dispatch({ action: 'verify' });
const review = await onboarding.dispatch({ action: 'review' });
// Show review.changes and ask the user to choose Deploy in the UI.
await onboarding.dispatch({ action: 'deploy', reviewId: review.review!.reviewId! });
```

The discover/configure/verify ports are **observations**. Configure confirms that
an already registered connection profile is complete; it does not accept secret
values, install software or edit the running system. If a person must supply
missing details, use the existing connection-profile/secret-storage adapters,
then retry Configure on the same immutable profile selection. Native resource
Create/Find → Connect → Verify and checkpoint/resume stay in their owning modules.

Each observation port declares an immutable adapter configuration digest and
required check IDs, then returns bounded `{id,label,status}` rows. Missing,
unknown, failed or unreadable observations cannot grant Review. Deploy delegates
to the same strategy's guarded `apply`; that strategy owns fresh preflight, drift
checking, resource mutation and application promotion. Bind real health, login,
allowed/denied and dependency checks there. A check labelled login is only as
strong as the host's actual login probe. `projectDeployment` may expose the
strategy's actual safe check rows; these replace the setup rows in `view.checks`
and are retained in `deployment.checks` and the native capture. Provided failed
or unknown checks cannot coexist with promotion. A throwing or malformed
projection after an effect yields incomplete, never ready. Without this optional
projection, the registered strategy remains an explicit opaque check boundary.
Changing either projection implementation requires a new declared configuration
digest, just as changing a registered check callback does.

`combineOnboardingCheckBindings` (from `footprintjs-iac/onboarding/node`) composes existing `DeploymentCheckBinding`
objects into one suite for reuse in both preflight and promotion. It rejects
ambiguous check IDs, request substitutions, aggregate mismatches and contract
drift. A missing required observation becomes inconclusive. Internal credentials,
raw HTTP bodies and error text are omitted from onboarding recordings.

## Workflow and evidence map

| Source | Responsibility |
| --- | --- |
| [types.ts](types.ts) | Public target, observation, action and snapshot contracts |
| [data.ts](data.ts) | Bounded readers and the shared stage names |
| [preset.ts](preset.ts) | Provider-free immutable adapter registration |
| [binding.ts](binding.ts) | Immutable versioned onboarding session identity |
| [checks.ts](checks.ts) | Generic shared check-suite composition |
| [create-onboarding-chart.ts](create-onboarding-chart.ts) | Sole native flowchart construction point |
| [stages.ts](stages.ts) | Recorded target admission, selected action, measured outcome |
| [workflow.ts](workflow.ts) | Durable intent, safe permissions, subscriptions and native execution |
| [store.ts](store.ts) | Atomic private ledger/evidence files and locking |
| [recording.ts](recording.ts) | Read-only evidence and native trace admission |
| [../deployment-strategy/types.ts](../deployment-strategy/types.ts) | External deployment strategy boundary |
| [../../test/onboarding.test.ts](../../test/onboarding.test.ts) | Failure, recovery, ownership, replay and contract tests |

Declared progression is Discover → Configure → Verify → Review → Deploy. Review
and Deploy remain separate user actions. Each transition uses a finite native
Bind target → selected action → Retain measured outcome chart. The transition
journal and captures stitch the five actions through the same immutable target
binding; this is not a second infrastructure engine.

Grey stages are pending. A stage becomes running only after durable intent is
stored and its registered operation begins. Terminal readiness and deployment
permissions are published only after the complete native capture is admitted.
There are no display timers. `subscribe`, `snapshot` and `recording` support Lens;
reads never invoke a provider or attempt automatic repair. Native evidence records
safe check observations and exact target/review/action identities. The strategy
and remote tools remain explicit external boundaries; stage names, static maps
and hashes do not establish their internal runtime causality.

A consumed or foreign review cannot be applied again. Rediscovery invalidates
all downstream review/promotion state. A thrown deployment or lost native capture
is uncertain and blocks another attempt. Explicit `reconcile` delegates only to
the strategy's registered observation/settlement port; it closes an admitted
failed attempt without promotion. Recovery then needs fresh observations and a
new review. Keep the same ledger: changing or deleting its directory is not
reconciliation.

Presets, profile selection and adapter/check digests are immutable for a session.
`onboardingBindingDigest(preset)` from `footprintjs-iac/onboarding/node` exposes
that captured configuration identity for provenance. It does not authorize a new
state path, target adoption or migration. A changed preset refuses the existing
session. Any later versioned-session registration must explicitly retain and
check the original host, onboarding and native deployment outcomes before
switching; do not derive an automatic replacement directory from the digest.
Never delete or move a ledger to bypass an uncertain attempt. Sessions are
bounded to 256 transitions and stop explicitly at that limit; history is not
discarded.

## Verification

Run `node --test test/onboarding.test.ts`, `npm run check`, `npm test` and
`npm run build` from the package root. The tests are offline and make no model or
remote-provider calls. Application consumers need their own real acceptance
against actual login, user-scoped allowed/denied access and dependency failure /
recovery. Passing these library contract tests does not qualify a production
server.
