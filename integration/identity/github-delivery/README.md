# Neo GitHub delivery consumer

Neo composes the public generic delivery workflow through a Git source adapter,
a Node/Python image recipe, a local kind artifact cache and the existing
versioned master deployment workflow. No Neo branching lives in the delivery
engine or Lens UI.

The host pins one existing, admitted `IdentityTarget` with a successful complete
native baseline deployment. GitHub credentials remain with the host's Git
credential mechanism. Node 24+, Git, Docker, kind and kubectl must be installed
and available on the host's PATH. Opening the dashboard checks the fixed host
configuration; the manual button starts source acquisition and deployment.
GitHub Actions and other CI triggers remain disabled.

Run the separate Lens consumer from a sibling checkout after building the core
and Lens:

```sh
node examples/neo-github-delivery.ts /absolute/path/to/target.json --id=neo-github-release-1 --port=0
```

The example's trusted composition root selects the repository and allowed ref.
A browser request selects only its configured delivery ID. It cannot supply a
repository URL, local path, command, credential or deployment target.

The workflow resolves an exact remote commit/tree, fetches a detached checkout,
builds content-identified images without changing the applied target, stores
them in the admitted existing kind cluster, seals the current master's plan,
updates only the existing Neo application and then measures three connections
and seven identity/access checks. A successful image build does not claim the
application's full separate acceptance suite passed.

Candidates are immutable under `candidates/<execution-id>/<source-tree>`.
Legacy tree-only candidates remain readable by their old examples. Another
explicit delivery may reuse the same tree without overwriting a prior attempt.
Revision IDs bind source commit/tree, artifact identities, parent and target;
identical trees from different commits remain distinct source revisions.

A failed or uncertain delivery stays retained and is never automatically
repeated. Inspect its native evidence and current resource state before
creating another explicitly bound delivery ID. Master promotion and canonical
target publication require complete matching native resource outcomes.

Lens projects actual resource and connection/access recorders. Completed
connection/access receipts are validated against native outcomes when the host
reopens, preserving measured live edges without rerunning probes. Source,
build and deployment receipts correlate their identities; they do not invent
causal edges inside external Git, Docker or Kubernetes operations.
