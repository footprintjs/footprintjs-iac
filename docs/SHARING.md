# Reproduce the Neo integration on another laptop

The IaC library and its Neo consumer integration live in [sanjay1909/footprint-iac](https://github.com/sanjay1909/footprint-iac). The application remains in [sanjay1909/neo-agentfootprint](https://github.com/sanjay1909/neo-agentfootprint). Both repositories are private; the recipient needs GitHub read access to both. A repository URL does not grant that access. This handoff uses Git checkouts, not an npm registry release.

## Prerequisites

Use a POSIX host environment: macOS, Linux, or WSL with a POSIX shell and `ps` available. Install Node.js 24 or newer, npm, Git, a running Docker engine, `kind`, and `kubectl`, with their commands on `PATH`. The Docker engine must be able to run Linux containers. The original local validation used kind 0.33.0, Kubernetes node image 1.37.0 and kubectl 1.36.1; those are the tested versions rather than a guarantee for every client version. First-time builds require network access to GitHub, container image registries, npm and Python package registries. Docker is required for this optional Kubernetes experiment; it does not change Neo's existing native development or production requirements.

Check the tools before cloning:

```sh
node --version
npm --version
git --version
docker info
kind version
kubectl version --client
```

## Clone and verify the library

Run from a directory where you want the sibling checkouts. Authenticate Git against GitHub first if needed; `gh auth login` is one option when the GitHub CLI is installed.

```sh
git clone https://github.com/sanjay1909/footprint-iac.git
git clone https://github.com/sanjay1909/neo-agentfootprint.git
git -C neo-agentfootprint worktree add --detach ../neo-agentfootprint-iac-fixture 6f876df846ae683cc9e9a114a51b638e31615af2
cd footprint-iac
npm ci
npm run check
npm test
npm run build
npm run capability:demo
```

The separate detached Neo worktree pins the application commit used in the original successful deployment. It leaves the normal Neo checkout free for ongoing development. If you already have Neo cloned, use that checkout for the `git worktree add` command instead of cloning it again. Do not discard existing edits. If the commit is unavailable in a shallow checkout, fetch that commit from `origin` first.

The library checks and capability demo must succeed before the Kubernetes test. The capability demo uses the simulator; its success alone does not verify Kubernetes deployment.

## Build, deploy and test the actual application

From the library root:

```sh
npm run neo:setup -- ../neo-agentfootprint-iac-fixture
```

You can pass another clean, committed Neo checkout path. That becomes a test of that commit rather than the pinned baseline. Tracked edits are refused so the build source is identifiable. No application `.env`, credentials, host dependencies or runtime artifacts are copied into the image context.

The setup command checks its prerequisites, builds the Node/UI and Python images from committed Neo source, creates or reuses the dedicated local kind cluster `footprint-iac-review` with `kindest/node:v1.37.0`, writes `.artifacts/kubeconfig-review`, and loads both images using tags derived from their content IDs. It saves the image selection in `.artifacts/neo/review-images.json`, then runs the high-level capability review through the IaC engine. It does not change your global kubeconfig or the separate `footprint-iac-test` cluster used by the original review.

Successful review checks include:

- Capability binding to real Kubernetes Namespace, Deployment and Service resources.
- Readiness of the Node/UI and Python containers.
- An unchanged deployment producing only no-op operations.
- Scaling one replica to two and back, preserving Deployment identity and pod configuration.
- Node and Python health, served application HTML, and the real SQLite inventory query filtered to `SHCSANPLVSW901` with its `LOCAL SEED` stamp.

The runner prints a loopback URL and leaves its port-forward running. Read the recorded result from the library root:

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; const r = JSON.parse(readFileSync(".artifacts/neo/review/latest.json", "utf8")); console.log(JSON.stringify({ status: r.status, url: r.baseUrl + "/?test", checks: r.checks, evidence: r.finalEvidencePath }, null, 2));'
```

Require `status: "passed"`. Open the printed URL on this laptop. The listener prefers port 15230 and chooses another local port when needed. A `127.0.0.1` URL on someone else's laptop is not a shared server address.

In the test UI, choose **zone audit (artifact)** and check the displayed table. This is a scripted chat response and table fixture. It is separate from the real seeded SQLite query exercised by the automated smoke test. Neither uses a live LLM or live SAN collector. The automated review does not itself run this browser check or the earlier separate chat/artifact acceptance checks.

## Repeat and investigate

Repeat `neo:setup` to rebuild from committed source and run the review again. If the images and cluster are already prepared and unchanged, rerun only the review:

```sh
npm run neo:review -- --context kind-footprint-iac-review
```

Each review saves its design, binding decisions, resource graph, results and native execution traces under `.artifacts/neo/review/run-*`. Durable inventory is reused in `.artifacts/neo/review/state` for the dedicated review target; `.artifacts/neo/review/latest.json` points to the latest successful result. Keep `.artifacts/` local: it contains cluster access material and execution evidence.

The report's `finalEvidencePath` is a saved `run.json` file. Use its actual path with the read-only evidence tools:

```sh
npm run iac -- replay /path/from/report/run.json
npm run iac -- inspect /path/from/report/run.json
```

For an unsuccessful run, read that run directory's `report.json` and available evidence; the successful-result pointer is not a verdict on a later failed attempt. An `inspect` default key of `failure` can be empty for a successful run. Evidence replay reconstructs recorded state; it does not redeploy resources. Earlier real-run replay/backwalk acceptance was a separate check, not an additional automatic verdict from this setup command.

Inspect only the explicit local target:

```sh
kubectl --kubeconfig .artifacts/kubeconfig-review --context kind-footprint-iac-review --namespace footprint-iac-neo-test get deployment,pods,service
kubectl --kubeconfig .artifacts/kubeconfig-review --context kind-footprint-iac-review --namespace footprint-iac-neo-test logs deployment/neo -c node
kubectl --kubeconfig .artifacts/kubeconfig-review --context kind-footprint-iac-review --namespace footprint-iac-neo-test logs deployment/neo -c python
```

If the detached listener stops, open a foreground listener in another terminal from the library root, choosing free local ports:

```sh
kubectl --kubeconfig .artifacts/kubeconfig-review --context kind-footprint-iac-review --namespace footprint-iac-neo-test port-forward deployment/neo 15231:5230 18001:8000 --address 127.0.0.1
```

Then run `node integration/neo/smoke.mjs http://127.0.0.1:15231 http://127.0.0.1:18001` and open `http://127.0.0.1:15231/?test`. A port-forward ends if its selected pod terminates; it is not a persistent production service.

## Scope and cleanup

This is an ephemeral local consumer fixture. Python reseeds its container-local SQLite data on startup. The profile supports this particular Neo program and HTTP endpoint; unsupported storage, identity and network-isolation requirements are rejected. It does not establish persistent state, cross-replica chat continuity, general cloud portability or production readiness. The generic built-in capability profile remains simulated. Backwalking follows captured dependencies; it does not prove the internal root cause of every external system failure.

Do not mix the older raw-stack `neo:trial` ownership with this capability review. Keep the library independently versioned and preserve Neo's existing development workflow. Any app-owned `infra/` adoption is a separate consumer change to review.

When you are finished and intentionally want to remove this entire disposable review cluster, run `kind delete cluster --name footprint-iac-review`. This deletes the application and all other workloads in that named cluster. Do not substitute another cluster name. Keep your review evidence if you want to investigate it later.

See [the integration guide](../integration/neo/README.md) for implementation details and [the agent handoff](NEO-AGENT-HANDOFF.md) for a message to forward.
