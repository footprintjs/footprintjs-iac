# Release strategies and adapters

A release is prepared once, sealed into a content-addressed `ReleaseManifest`, then promoted through configured environments. A pipeline never rebuilds artifacts for each environment. Source catalogs and build preparation live in [`releases.md`](releases.md); checks and finite scheduled invocations live in [`checks-and-triggers.md`](checks-and-triggers.md).

The reusable dependency direction is:

```
Host composition / consumer recipe / Lens
  → immutable release + pipeline definition
    → pure strategy plan
      → registered rollout / observation / check adapters
        → existing infrastructure engine or external tool
```

Environment names and tools are host registrations. The core does not special-case development, gamma, production, Neo, Kubernetes or a cloud vendor. A consumer chooses policy, adapters implement effects, and the existing resource engine still computes selective resource changes.

## Public entry points

- `footprint-iac/pipeline`: types, structural admission, built-in pure strategies, `compileRolloutPlans`.
- `footprint-iac/pipeline/node`: workflow, private local stores, native evidence reader, existing-engine bridge.
- `footprint-iac/releases/node`: exact manifest digest admission and build-once preparation.
- `footprint-iac/checks/node`: registered HTTP, host-command and Playwright checks with finite recordings.
- `footprint-iac/triggers/node`: manual, interval and validated stage-event dispatch.

```ts
import {
  PipelineWorkflow, FilePipelineStore, FilePipelineTargetStore,
  directStrategy, canaryStrategy, deploymentRolloutAdapter,
} from 'footprint-iac/pipeline/node';

const workflow = new PipelineWorkflow({
  release: sealedManifest,
  definition: {
    version: 1,
    id: 'application-release',
    label: 'Application release',
    configurationDigest: hostConfigurationDigest,
    stages: [
      {
        id: 'development', label: 'Development',
        target: { id: 'development-app', scope: developmentTargetScope },
        strategyId: 'direct', adapterId: 'existing-engine',
        checks: [{ runnerId: 'acceptance', suiteId: 'login-access', suiteDigest }],
        rollback: 'disabled', promotion: 'automatic',
      },
      {
        id: 'gamma', label: 'Gamma',
        target: { id: 'gamma-app', scope: gammaTargetScope },
        strategyId: 'direct', adapterId: 'existing-engine',
        checks: [{ runnerId: 'acceptance', suiteId: 'login-access', suiteDigest }],
        rollback: 'automatic', promotion: 'manual',
      },
    ],
  },
  registry: {
    strategies: [directStrategy(), canaryStrategy()],
    adapters: [existingEngineAdapter],
    checks: [acceptanceRunner],
  },
  store: new FilePipelineStore(privateAttemptDirectory),
  targetStore: new FilePipelineTargetStore(sharedPrivateTargetDirectory),
});

workflow.subscribe(state => publishSafeView(state));
const state = await workflow.start();
// A manual promotion gates entry into the next environment.
if (state.pendingAction?.kind === 'promote') {
  const { kind, ...request } = state.pendingAction;
  // Only submit after the operator chooses to promote the reviewed release.
  await workflow.promote(request);
}
```

The host must bind adapter versions, target configuration, policy and acceptance suites into `configurationDigest`. Credentials and host paths stay inside adapter closures or private publication metadata. A browser chooses registered IDs; it does not submit commands, endpoint URLs, credentials or arbitrary adapter implementations. Read-only release discovery is distinct from preparing or deploying a release.

## Strategy ports

A `RolloutStrategy.plan` is synchronous and pure. It receives a detached immutable stage definition and sealed release and returns a bounded sequence of `action` or `check` steps. A check step runs the stage's registered suites with reason `rollout-analysis`. Every successful rollout also runs `after-deploy` acceptance checks and reads the actual deployed release identity.

The built-in strategy operation IDs are:

| Strategy | Required operations | Measured checks |
| --- | --- | --- |
| Direct | `deploy` | After deploy |
| Canary | `deploy-candidate`, `set-traffic`, `promote-candidate` | Between increasing traffic weights and after promotion |
| Blue green | `prepare-environment`, `switch-traffic`, `promote-environment` | Before and after traffic switch, then final acceptance |

Canary weights default to `[5, 25, 50, 100]`; `parameters: { weights: [10, 50, 100] }` selects another strictly increasing bounded sequence ending at 100. An adapter must actually realize traffic weights and candidate isolation. Registering a canary strategy does not make a direct-only target canary-capable.

`RolloutAdapter.capabilities` declares supported operation IDs. Entire-pipeline admission rejects missing operations, unsupported recovery and unknown suite digests before effects. An optional pure `admit` hook can reject target-specific constraints. Add a new strategy by returning another pure plan; add another provider by implementing the same rollout and observation ports. No execution-engine change is required.

An action returns `succeeded`, `failed` or `unknown`. Exceptions and invalid receipts are treated as unknown provider outcomes. Native summaries include status and validated resource change IDs/actions. Opaque metadata and provider exception text remain out of native evidence. The adapter's `observe` callback must measure the target's actual release identity; echoing the requested digest is not verification.

## Existing selective resource engine

`deploymentRolloutAdapter` bridges the current `DeploymentAdapter.plan/deploy/verify` without modifying the engine:

```ts
const existingEngineAdapter = deploymentRolloutAdapter({
  id: 'existing-engine', label: 'Existing infrastructure engine',
  deployment: existingDeploymentAdapter,
  observeRelease: readActualTargetRelease,
  publicationForRelease: release => privatePublicationByDigest.get(release.digest)!,
  // Opt in only after the host reviews application/data compatibility.
  restore: 'application-only',
});
```

The private publication's artifact IDs and digests must match the sealed manifest before planning. This supports consumers whose private metadata points to a host-controlled checkout, candidate directory or existing master-workflow review. The bridge carries actual selective plan changes into recorded receipts. It does not invent per-resource provider timings or replacement support.

The underlying planner distinguishes create, update, verify, delete and no-op. It checks ownership, provider target scope and resource identity. Kubernetes physical identity changes and field removals currently require an explicit reviewed replacement; they are not silently treated as an in-place update. Stateful data migration requires a separate reviewed adapter/workflow. Restoring application artifacts does not reverse database writes, restore volumes or establish schema compatibility.

## Applied, verified and recovery

The shared target ledger retains **last applied** and **last verified** separately. Only measured acceptance plus exact observed release identity and fully retained native evidence establish a verified release. A historical verified release is not a claim of perpetual application health.

| Rollback policy | Confirmed stage failure |
| --- | --- |
| Disabled | Stop promotion; retain actual applied identity and previous verified release |
| Manual | Stop at a durable recovery action; require its exact stage, release digest and token |
| Automatic | Restore a retained verified release, run recovery checks, observe restored identity, then stop the failed candidate |

Rollback-enabled stages require a verified baseline before any release write. Establish the first healthy release with rollback disabled; enable recovery on a later immutable attempt. The baseline's native receipt must bind to the same target identity and scope. An unknown write, target drift, missing receipt, incomplete capture or failed recovery never authorizes another automatic effect. An operator must inspect and reconcile an uncertain provider outcome before a new attempt.

Manual recovery checks that the target has not been managed by another attempt in the meantime. Manual actions are bound to the exact execution, stage, definition and sealed release. A failed candidate is never promoted after successful recovery. Reopening a passed attempt returns retained results; `start()` refuses to repeat a failed, waiting or uncertain attempt.

## Native recordings and Lens

Each stage runs its admitted plan as a native FootPrint chart. Each action writes durable intent before adapter effects. Native decision nodes record which steps run and which are skipped. Actual check results, observations and final outcomes drive Lens; configured strategy steps are a preview until recorded execution exists.

A manual gate and its continuation are explicit finite segments. Recovery is a separate finite chart referencing the failed rollout's native run ID. These are durable workflow actions, not a claim of one executor checkpoint spanning every tool or process. Evidence retains the native structure, snapshot, trace, decisions, narrative and control-dependency lookup. The reader checks complete trace replay against the retained snapshot without calling adapters. Cross-run causal edges are not fabricated.

Each attempt has a private immutable directory. All attempts managing the same target must share one `FilePipelineTargetStore` directory. Local target locks cover observation, rollout, checks, persistence and recovery; no lock remains held while an operator considers a manual gate. These are single-machine locks. Multi-host deployment requires an external transactional lock/state service before claiming distributed safety.

Scheduled monitoring is a separate finite check dispatch against the currently measured deployed release. Interval scheduling exposes persisted due times, duplicate handling, overlap policy and missed-run behavior. A host calls the dispatcher from a service or scheduler; a browser timer is not a durable scheduler. Monitoring failures do not silently trigger application rollback.
