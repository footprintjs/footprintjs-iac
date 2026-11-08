# Prompt to forward to Rahul's agent

We built an independent FootPrintJS-based IaC library and deployed the actual Neo AgentFootprint app through its high-level capability API and real Kubernetes adapter. Please review and reproduce this integration on your own laptop.

Repositories:

- Library and integration: https://github.com/footprintjs/footprint-iac
- Consumer application: https://github.com/sanjay1909/neo-agentfootprint
- Setup and test instructions: https://github.com/footprintjs/footprint-iac/blob/main/docs/SHARING.md

Both repositories are private. Verify that your GitHub identity has read access to both. If access fails, report which repository needs access; do not treat the other laptop's local paths or localhost URL as accessible here.

Start with `docs/SHARING.md`. It gives clone commands, a separate detached Neo worktree pinned to tested commit `6f876df846ae683cc9e9a114a51b638e31615af2`, library checks, and the actual application deployment command:

```sh
npm run neo:setup -- /path/to/clean/neo-agentfootprint-iac-fixture
```

Prerequisites are a POSIX environment (macOS, Linux or WSL, including `ps`), Node.js 24+, npm, Git, a running Docker engine, kind and kubectl. This optional local experiment uses a dedicated `footprint-iac-review` kind cluster and a private workspace kubeconfig. It preserves the app's existing native development workflow.

Review these files in the library:

- `integration/neo/system.ts`: the compute service and HTTP endpoint declarations.
- `integration/neo/kubernetes-profile.ts` and `integration/neo/profile/`: the narrow real binding for this consumer.
- `integration/neo/run-review.ts`: framework apply, readiness, no-op and scale checks, then a local review server.
- `docs/CAPABILITIES.md`: the generic compute, storage and network foundation and wrapper contract.
- `VALIDATION.md`: the recorded validation scope and limitations.

Require the library checks to pass and the local review report to say `passed`. Confirm Node/Python readiness, no-op deployment, scaling 1 → 2 → 1 with unchanged identity and pod configuration, served application HTML, and the real seeded SQLite inventory query with its `LOCAL SEED` stamp. Then manually open your locally printed `/?test` URL and try **zone audit (artifact)**. That chat/table response is scripted, separate from the real SQLite query; no live model or collector is configured. Report that browser check separately from the automated runner's results.

Inspect the emitted system design, binding mappings, resource graph and saved execution evidence. Replay is read-only reconstruction of recorded state. Backwalking follows captured dependencies; it is not proof of every external root cause.

Keep the library independent. Recommend how Neo should consume it through a small app-owned `infra/` directory and an explicit composition root, without replacing the current development workflow. Use small helpers, stages and subflows, with each flowchart's construction in its own file. Future domain wrappers should compose the foundation rather than add domain switches to its engine.

Report what you verified on this laptop, failures with evidence, unsupported requirements and the smallest next consumer integration step. This handoff requests review and reproduction; it does not establish production readiness or general multi-cloud support.
