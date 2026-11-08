# Validation results

Current local library: **footprint-iac 0.3.0**. Capability, binding, retention, graph, concurrency, recovery and consumer acceptance checks passed. The high-level Neo consumer has now also been deployed and tested in the recreated local kind cluster. The earlier raw-stack trial remains documented separately below.

These are recorded results from the development laptop, not a claim that a fresh clone has already run them. Generated `.artifacts/` evidence, kubeconfig, state and logs are private local outputs and are intentionally excluded from Git. Reproduce the checks with the [sharing guide](docs/SHARING.md). CI runs library checks and the simulation demo; the real Neo integration requires a separately authorized private Neo checkout and local Docker/kind.

## Framework

- `npm run check`: passed.
- `npm test`: **159 passed, 0 failed, 0 skipped**.
- `npm run build`: passed; the compiled library imports successfully.
- `npm run demo`: passed creation, response-loss reconciliation, no-op planning, failed update, state replay, backward investigation, and repair.
- `npm run graph:demo`: passed fluent serial/fork/join declaration, actual provider concurrency of two, one create send despite a lost response, unchanged no-op, matching recorded graph digest, failed update investigation, read-only replay and repair.
- Compiled root and focused package exports (`graph`, `graph/render`, `graph/svg`, `diagnostics`, `system`, `system/render`, `binding`) import and run successfully.
- Native parallel JSONL independently reconstructs state and retains each resource stage as the exact writer; dependent backwalk reaches both fork branches without the final execution tree.
- Graph artifacts reject unknown/tampered envelopes, accessor-bearing inputs before invocation, dependency cycles and unsupported required boundary enforcement through every public planner/execution entry point.
- Standalone SVG views parse as XML; a generated security view was rendered and visually inspected. Graph JSON, Mermaid and SVG derive from the same artifact.

Local simulator report: `.artifacts/system-design/latest-report.json`. The new Neo graph consumer has four hermetic tests preserving the exact earlier resource definitions and deployment dependencies.
- Package dry run: generated artifacts and installed dependencies are excluded. Nothing was published.

The suite includes actual `SIGKILL` worker tests, not just injected exceptions. A create persisted by the simulator before the worker dies is discovered on restart without another apply. Native FootPrint records from killed runs remain explicitly incomplete. Other tests cover ownership, target binding, omission handling, drift, reverse-order pruning, locking, CLI behavior, and lost capture.

## Portable handoff validation

On November 8, 2026, a clean local Git clone with no installed dependencies or generated artifacts passed `npm ci`, typecheck, all **159 tests**, build and the capability demo. The six added setup/listener regression tests cover isolated targets, foreign cluster refusal, local kubeconfig admission, complete image identities, source/image matching and recovery from a partially bound port-forward.

From that clone, `npm run neo:setup -- /path/to/clean/neo-agentfootprint` rebuilt both images from the pinned Neo source commit, created the separate `footprint-iac-review` kind cluster, loaded content-derived image tags and passed the real capability deployment, readiness, no-op, scale 1→2→1 and HTTP/SQLite checks. A second `neo:review` passed using the saved durable inventory. Occupied port15230 correctly fell back to a free port; the original test server, Deployment UID and pod configuration remained unchanged.

Separate read-only CLI replay reconstructed the saved final shared state exactly, and CLI inspection parsed the real run evidence. These are additional acceptance checks rather than automatic assertions inside `neo:setup`. The package dry run included the portable setup and guides and excluded local state, credentials, recordings and installed dependencies. This validates a fresh clone on the development laptop; another operating system or laptop still needs to run its own checks.

## Capability base and wrappers

- `npm run capability:demo`: passed high-level compute/storage/network declaration, a separate agentic recipe, explicit simulation binding, expanded graph generation, actual provider concurrency of two, uncertain-create single send, unchanged no-op, failure-to-capability mapping, read-only replay/backwalk, repair and removal retention.
- `src/system` has 18 runtime tests plus compile-time negative API checks.
- Binding has 14 tests, including exact requirement coverage, ambiguous selections, target identity, multi-resource expansion, accessors, async callbacks, simulation/provider mismatches and required constraints.
- Eight retention tests cover persisted protection, saved dependency closure, explicit release, restart, CLI cleanup, policy-only no-op and failed-release safety.
- Regrouping stable capability IDs produces no provider writes. Clearing removal retention alone also produces no provider writes.
- Both high-level intent and expanded resource diagrams are generated. Structured inspection carries the originating capability path, source design digest and adapter mode.
- The built-in capability profile is simulation-only. It does not provision a live cluster, database backend, IAM policy or workload, and does not verify production durability. The separate Neo profile supplies the narrow real implementation tested below.

Local capability demo report: `.artifacts/capabilities/latest-report.json`. See [CAPABILITIES.md](docs/CAPABILITIES.md) for public API semantics and wrapper boundaries.

## Current high-level Neo review

- `npm run neo:review -- --context kind-footprint-iac-test`: passed against the real local Kubernetes API.
- The capability model and explicit real consumer profile expanded into the exact packaged Namespace, two-container Deployment and HTTP Service, deployed only through `InfraEngine`.
- Live readiness, unchanged no-op planning and scaling1→2→1 passed. Deployment UID, app metadata, selector and pod template stayed unchanged.
- Node/Python health, actual app HTML/built assets and the real filtered SQLite inventory query with `LOCAL SEED` provenance passed.
- Nine additional chat/artifact HTTP checks passed: scripted answer/table, same-session redemption200 and cross-session denial404, with full fixture identifiers preserved. These acceptance checks were run separately from the review runner.
- Separate saved real-run replay acceptance matches the snapshot; the recorded deployment result supports backward traversal without provider effects.
- The review runner leaves a loopback server running. Its exact URL, owned PID, command/start time and log paths are in the local `.artifacts/neo/review/latest.json`.
- Image/source attestation matched clean source commit6f876df846ae683cc9e9a114a51b638e31615af2. Tracked upstream app files remain unchanged.
- Local browser automation was unavailable because Work settings disable it; HTTP assets and chat/artifact acceptance were verified. No visual browser result is claimed.

This review uses the scripted model and local fixture data. It does not prove live collector/model behavior, production authentication, persistent storage or multi-replica conversation continuity.

## Real Kubernetes trial

Cluster: `kind-footprint-iac-test`, Kubernetes `v1.37.0`, running locally in Docker.

Namespace: `footprint-iac-neo-test`.

App source: clean committed snapshot of the separate private `sanjay1909/neo-agentfootprint` repository at `6f876df846ae683cc9e9a114a51b638e31615af2`.

The original checkout's tracked files were not modified. Its pre-existing untracked `be-server/.artifacts/` directory was left alone.

The final trial verified:

1. Resource planning, apply and readiness.
2. An unchanged plan/reapply consisting entirely of no-op operations.
3. A real scale from one replica to two, followed by a scale back to one; the Deployment UID, app metadata, images and pod template remained unchanged.
4. Backend health, served UI HTML, Python health and the real SQLite `mds_get_switch_inventory` query, including exact switch filtering and `LOCAL SEED` provenance.
5. Rejection of a negative replica count by the Kubernetes API.
6. Saved Foottrace replay equal to the captured state, plus a backward slice reaching the rejected desired input and governing decisions.
7. The existing app remaining healthy after rejection, followed by restoration and final all-no-op convergence.

Local machine-readable report: `.artifacts/neo/trial-report.json`.

Local readable failure slice: `.artifacts/neo/failure-backwalk.txt`.

Local test log: `.artifacts/test-results.txt`.

## Integration fixes made during testing

The Python sidecar requires the canonical metadata shipped by the installed AgentFootprint Node package. Its Dockerfile now obtains the exact file from the Node image; the build checker verifies identical bytes across both images. The verified file SHA-256 is `04e14b45556ad60fd8ff971ed9710f5cb5a4de59ecd4607a32f60a7834037382`.

The first live update exposed Kubernetes's distinct POST/Apply manager identities. The adapter now supports a guarded bootstrap migration, retaining UID/resourceVersion preconditions and refusing competing ownership. Unsupported desired-field removals fail during planning rather than falsely reporting convergence.

Docker's direct registry path timed out. Required base images were downloaded through the host and loaded into the local daemon; no global Docker settings were changed.

## Scope and retained environment

The test uses seeded SQLite data and the app's scripted model. It did not exercise a live SAN collector or LLM provider. Node dependencies came from the existing Neo lockfile; the install reported 21 upstream audit findings, and dependency upgrades were outside this integration change.

This remains a single-machine prototype with four Kubernetes resource kinds. Execution defaults to one resource at a time; configured bounded batches can execute eligible resource operations concurrently, and pruning remains sequential. Cross-run/tool causal stitching, provider-output interpolation, fine-grained provider subflows, distributed state, arbitrary providers and automatic rollback are not implemented. Boundary groups are descriptive; required enforcement is rejected until a supported lowering/verifier exists. Kubernetes field/list removal and automatic replacement are explicitly unsupported.

The original test cluster was stopped after an earlier session and later recreated for the high-level review above. A localhost URL and an old saved report do not establish present health on another laptop. Use the [portable setup and test instructions](docs/SHARING.md) to create a separate `footprint-iac-review` cluster, generate fresh evidence and obtain that laptop's actual review URL.
