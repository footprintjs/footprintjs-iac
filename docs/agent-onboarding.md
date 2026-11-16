# Working on reusable onboarding

Start with the [current source map](onboarding/README.md), [public contracts](../src/onboarding/types.ts) and [module guide](../src/onboarding/README.md). Briefly identify the intended change and any missing source context, then inspect the owning source freely. The map is navigation, not an alternative to correctness or tests.

Use `footprintjs-iac/onboarding` for provider-free definitions, readers and policies. Load `footprintjs-iac/onboarding/node` in the trusted host for the durable workflow and check composition. Register private adapters in the consumer composition root. Browser requests select bounded actions and an exact review ID; they never supply executable code, credentials or a host path.

The preset composes Discover → Configure → Verify → Review → Deploy. Discovery measures the registered target. Configuration validates an admitted private configuration; it does not establish live connectivity. Verification measures required prerequisites. Review delegates to the existing deployment strategy. Deploy consumes that exact sealed review, revalidates and runs its required application checks. The strategy keeps its existing physical target and native controller ledger. A viewer must not add another deployment engine.

Keep each chart's construction in [one creation file](../src/onboarding/create-onboarding-chart.ts), with small stage/helper modules. Do not place Neo names, authentication protocols, operating systems or site facts in generic action admission. Consumers register those adapters. Check IDs and required policy come from the registered consumer; health alone is insufficient when that consumer requires login, allowed/denied access and dependency checks.

For a change, distinguish three kinds of evidence:

- **Declared source:** stage catalog, dependency links, callback ownership and hashes. Regenerate the source map after source changes. Hashes establish freshness only.
- **Observed execution:** complete native FootPrint captures, exact run and review IDs, recorded reads/writes/decisions, provider confirmations and application results.
- **Unproved boundaries:** callback/provider internals or unavailable observations. State the gap. An unknown or an incomplete capture cannot become success.

Test failed and unknown prerequisites before mutation, stale review rejection, repeated action/reopen behavior, uncertainty and explicit reconciliation. Verify that snapshots/replay call no providers and expose no secrets. After focused tests, run `npm run context:onboarding`, `npm run check`, `npm test` and `npm run build`. CI remains off. No model calls, benchmarks or infrastructure changes belong in ordinary context verification.

This guidance applies the source-linked-context approach from [flow-development-benchmarks](https://github.com/footprintjs/flow-development-benchmarks). That repository is a separate research study; its code, raw evidence and historical reports are not runtime dependencies here. Its known-task observations do not establish an efficiency improvement for InfraChart. We have not run a new model benchmark for this feature.
