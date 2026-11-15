# Manual GitHub delivery: setup and review

This feature adds reusable source, build, artifact storage and deployment ports to the base library. The Neo example is a consumer. Its manual Lens button fetches a selected remote GitHub version, builds two application images, stores them in the admitted local kind cluster, reviews the existing master revision, updates the affected application and runs real connection/access checks. CI is not used.

## Repositories and prerequisites

- Base: https://github.com/footprintjs/footprintjs-iac
- Viewer: https://github.com/footprintjs/footprintjs-iac-lens
- Example application: https://github.com/sanjay1909/neo-agentfootprint

Use sibling base/viewer checkouts containing this feature. The base and viewer repositories are public; the Neo source requires the recipient's GitHub read access. Requirements are Node.js 24+, Git, npm, Docker, kind and kubectl. The host Git credential helper must already be able to read the private Neo repository; tokens do not belong in repository URLs or the browser.

Run the base check/test/build and then the viewer check/test/build directly on the local machine. Neither command dispatches GitHub Actions. See the existing [Neo setup guide](SHARING.md) for preparing a local target.

## Run the upgrade example

The example requires a prepared, healthy Neo identity target with a successful native `deployment.json`. For an actual v1-to-v2 upgrade, use a v1 deployment; an already-v2 target cannot demonstrate that same upgrade again. Do not copy target descriptors, ports, credentials, image IDs or evidence paths from another laptop.

From the viewer checkout:

```sh
node examples/neo-github-delivery.ts /your/prepared/target.json --id=neo-github-review --port=0
```

Open the printed loopback URL. Opening the viewer admits the existing baseline; it does not execute the source/build/deploy pipeline. Press **Deploy from GitHub** once. The example's trusted host configuration selects the existing Neo demo branch `demo/neo-master-upgrade-v2-20261111`. The Git adapter resolves and records its exact remote commit and tree before building. The browser submits only the configured delivery ID.

Observe **Get code → Build → Store package → Review changes → Deploy → Check**, alongside the running-system chart. Delivery details show the pinned version, produced artifacts, actual planned actions and measured acceptance checks. Resource and connection states come from their own native provider/check recordings.

## Review expectations

- A real v1-to-v2 test updates `neo-app`; the directory, identity provider, namespace, policy and Service stay unchanged when their desired configuration and observations are unchanged.
- The final checks include three real communications checks and seven identity/access checks. Building an image alone does not establish these outcomes or replace the application's broader acceptance suite.
- Reopen Lens and confirm saved deployment and verification evidence still appears. No provider effects should be repeated by reading a completed delivery.
- Inspect the delivery, deployment, connection and identity recordings. They have explicit identities and references; independent runs are not joined by invented causal edges.
- A store represents one immutable delivery attempt. A completed attempt is read-only/idempotent. A failed, interrupted or uncertain attempt needs inspection and provider reconciliation before an explicitly new attempt. Arbitrary stage resume and automatic retry are not claimed.

The public entry points are `footprintjs-iac/delivery`, `footprintjs-iac/delivery/workflow` and `footprintjs-iac/delivery/git`. See [delivery contracts](delivery.md) and [Git source behavior](delivery-git.md). Generic build, artifact and deployment ports can be implemented for other applications and environments; this tested Neo binding uses local Docker/kind, not a hosted registry or cloud deployment service.

Keep CI off. Review the implementation and recorded evidence before merging. No merge is part of running this example.
