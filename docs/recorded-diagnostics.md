# Recorded dependency queries

`footprint-iac/diagnostics/recorded` is the browser-safe entry point for a dashboard or another consumer of the base library. It imports no filesystem, provider, application wrapper, React or credential-storage code.

```ts
import { queryRecordedDependencies, readRecordedDependencyResult } from 'footprint-iac/diagnostics/recorded';

const answer = queryRecordedDependencies({
  snapshot: savedNativeEvidence.snapshot,
  controlDeps: savedNativeEvidence.controlDeps,
}, 'progress:communication:0');

if (answer.status === 'available') {
  showRecordedNodes(answer.dependencies.nodes);
  showRecordedEdges(answer.dependencies.edges);
  showCoverage(answer.provenance, answer.coverage, answer.limitations);
}
// A host can validate a saved result before returning it in diagnostic history.
const reopened = readRecordedDependencyResult(savedAnswer);
```

The adapter composes FootTrace's public `keysReadFromExecutionTree`, `sliceForKey` and `sliceToJSON`. The `backwalk` and `explainRun` APIs use the same slice construction; the base library contains no second causal traversal. Per-write attribution is explicit. This was already the released variable-slice default; surfacing it does not claim a newly enabled capture channel.

Answers contain native node IDs, labels, written-key names, flat edges and coverage metadata. They contain no commit values, retained read values, raw failure messages or shared state. The query never reads `snapshot.sharedState`, `initialState`, argument values or a secret store. It inspects the supplied public native commit record and read-map keys only; the host remains responsible for authorizing and redacting that recording before supplying it. Accessors in consumed recording fields are refused, and diagnostic exceptions return fixed error codes. This is an ordinary inert-data boundary, not a sandbox for arbitrary executable proxies or a replacement for the host's redaction policy.

The result has three states: `available` has a recorded writer; `missing` retains FootTrace's missing reason; `unavailable` reports invalid input or a query limit. An unavailable result never presents an empty graph as proof of no dependencies. A zero read-key count cannot distinguish unrecorded reads from a run that read nothing. Missing per-write provenance falls back conservatively through FootTrace. Control maps must come from the selected native recording; their absence remains explicit rather than guessed from graph position or recorder names.

Edges preserve FootTrace's `kind`, `basis`, `builtOn` and `overlap` fields. A `partial-write` or `built-on-view` edge describes how a value was assembled. An overlap marks a possible source rather than selecting one definite producer. Native truncation, pre-run origins and other honesty notes survive the flat projection. Child scopes, external calls, unrecorded execution and earlier pause segments do not acquire evidence from a root query.

`order` lists the first actual commit of each selected native node using its array position in the supplied log. A viewer should label this **Recorded commit order**: parallel work can start earlier and commit later. It must not use this list to invent start times, elapsed durations, deployment progress or causal edges.

Default output limits are 160 nodes, depth 32, 4,096 edges and 256 KiB. Callers may lower these limits through `RecordedDependencyOptions`. Admission additionally bounds the input record, trace rows, execution metadata and public payload work. A walk that reaches its native node/depth limit preserves FootTrace's truncation marker; an oversized wire result is refused with `query-limit`.

`readRecordedDependencyResult` copies and freezes the value-free wire schema, checks bounds, referenced native IDs, ordering and summary consistency, and rejects extra payload fields. It validates structure only. It cannot authenticate a storage owner, prove that a label is truthful or turn recorded candidate dependencies into a physical root-cause verdict.
