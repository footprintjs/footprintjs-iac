# Local Neo Kubernetes integration

For another laptop, start with [the setup and sharing guide](../../docs/SHARING.md). It includes GitHub access requirements, a pinned application worktree, prerequisites, verification, troubleshooting and cleanup.

This consumer packages the real `neo-agentfootprint` application from clean committed source without changing that checkout. One pod contains the Node backend/UI and Python tool sidecar. The app's real SQLite query code operates on its existing seeded fixture and preserves `LOCAL SEED` provenance. Model replies are scripted. No model key, InfluxDB, production credentials or live SAN collector is configured.

This optional experiment requires Docker and kind on the review laptop. It does not change the upstream app's native development or documented systemd production workflow. Python rebuilds an ephemeral SQLite fixture in `/tmp/footprint-iac-neo-seed` at each container start; the integration does not provide production storage.

## Portable setup

From the library root, after `npm ci`, the typecheck, tests and build:

```sh
npm run neo:setup -- /path/to/clean/neo-agentfootprint
```

The command checks Node 24+, Git, Docker, kind and kubectl; builds both images; creates or reuses the dedicated local kind cluster `footprint-iac-review` with `kindest/node:v1.37.0`; exports `.artifacts/kubeconfig-review`; loads the images; and runs the high-level review. It preserves global kubeconfig and the separate `footprint-iac-test` cluster. Rerunning setup rebuilds and reviews the selected committed source.

Setup assigns image tags derived from their local content IDs and saves them in `.artifacts/neo/review-images.json`. A changed image therefore changes the desired Deployment template instead of reusing an ambiguous `:local` tag. With those images already loaded and the review cluster prepared, rerun just the checks:

```sh
npm run neo:review -- --context kind-footprint-iac-review
```

## Capability binding and execution

`createNeoSystem()` in `system.ts` declares a compute service and HTTP endpoint. `neoKubernetesProfile()` in `kubernetes-profile.ts` selects a narrow real implementation for this packaged fixture. The compute capability expands to Namespace and Deployment resources; the endpoint expands to a Service. All workload mutations pass through `InfraEngine` and the existing Kubernetes adapter.

The Namespace is `footprint-iac-neo-test`, Deployment and Service are `neo`, and the Service publishes Node port 5230. Node reaches Python over pod loopback with `PY_TOOLS=1`, `SEO_MCP=0` and `PY_BASE_URL=http://127.0.0.1:8000`. Both containers must pass readiness.

The review applies the bound graph, verifies readiness and unchanged no-op planning, scales one replica to two and back, and independently checks unchanged Deployment identity and pod configuration. It then opens a detached loopback port-forward and checks both health endpoints, application HTML, and the real SQLite inventory query filtered to `SHCSANPLVSW901`, including its provenance stamp. Failures remain failures; an unreachable endpoint is not counted as a pass.

The runner prints the server URL, preferring port 15230 with an available-port fallback. Open its `/?test` page and choose **zone audit (artifact)**. The scripted zone-audit table is a separate fixture from the real SQLite query. The automated review does not itself run this browser check or the earlier separate chat/artifact acceptance checks.

Each run saves its design, binding mappings and decisions, expanded graph, apply results, native traces and report under `.artifacts/neo/review/run-*`. `.artifacts/neo/review/latest.json` records the latest successful result and actual local URLs. The portable target reuses `.artifacts/neo/review/state` for durable inventory. `forward.json` records the listener PID, command, process start time and private log. The listener survives the runner exiting, but ends if its selected pod terminates.

The existing original-review command remains available for its original target:

```sh
npm run neo:review -- --context kind-footprint-iac-test
```

That context uses `.artifacts/kubeconfig`. The portable review uses `.artifacts/kubeconfig-review`; do not substitute an arbitrary remote context.

The profile rejects arbitrary programs and unsupported storage, identity, isolation, port and protocol requests. A Namespace does not establish network isolation. The generic built-in capability profile remains simulation-only; this consumer supplies the tested real implementation. Scaling readiness does not establish cross-replica chat continuity or persistent state.

## Image packaging

To build the base images separately:

```sh
node integration/neo/build.mjs /path/to/clean/neo-agentfootprint
```

`prepare.mjs` uses `git archive HEAD`, refuses tracked edits and tracked credential/config files, and records source commit and build context in `.artifacts/neo/source.json`. It excludes untracked files, `.env`, host `node_modules` and runtime artifacts. Docker applies additional exclusions. The Node image installs the original exact lockfile with `npm ci` and the app's existing PowerScale postinstall. Keep development dependencies because the runtime uses `tsx`.

The Python image copies the installed AgentFootprint package's exact `canonical-notes.json` from the Node image. The build runs `check-package.mjs` to compare both images; missing or stale metadata fails the packaging check. Run `node integration/neo/check-package.mjs` independently after rebuilding either image.

The base image names are `footprint-iac/neo-node:local` and `footprint-iac/neo-python:local`. Portable setup tags and loads content-derived references for its review. All fixture images use `imagePullPolicy: Never`; they must be present inside the selected local cluster. Rebuilding the base images alone does not update the portable review's saved image selection; rerun `neo:setup` for that.

Builds require access to base-image, npm and Python registries. Python 3.11 installs the application's own requirements, including its pinned MCP package, even though this integration selects the supported HTTP bridge. A failed dependency install is a build failure; do not omit dependencies to make it pass.

## Older raw-stack trial

`createNeoStack()` in `stack.ts` exports the low-level `Stack` fixture; `write-stack.ts` writes `.artifacts/neo/stack.json`. This older path uses different framework resource IDs from the capability binding. Do not run it over capability-owned resources. Use a separate clean cluster or reviewed cleanup before changing deployment owners; ownership refusal is intentional.

With the base images already loaded into that older isolated target, its command is:

```sh
KUBECONFIG=.artifacts/kubeconfig node integration/neo/run-trial.ts --context kind-footprint-iac-test
```

It checks apply/readiness, no-op behavior, scale 1 → 2 → 1, app/SQLite smoke, a real rejected `replicas: -1` update, saved failure replay/backwalk, and valid-state restoration. State lives in `.artifacts/neo/state`, traces in `.artifacts/neo/traces`, and the result in `.artifacts/neo/trial-report.json`. Its own port-forward closes after the trial; the app workload remains. The portable high-level review is the recommended handoff path.

See [the sharing guide](../../docs/SHARING.md#repeat-and-investigate) for explicit kubeconfig troubleshooting and manual port-forward commands. Do not run the upstream production deploy script or Influx seeding as part of this fixture.
