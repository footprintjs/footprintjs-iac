# Shared preparation internals

This private module owns the one four-stage source/build chart and its native
execution, progress and intent helpers. Public source and release preparation
remain distinct wrappers. They own their definition hashes, readers, evidence
kinds and output policies: an exact source receipt is not a release manifest.

Do not add a source/release mode switch here. Wrappers inject their capture IDs,
safe evidence fields and optional completion policy. Existing stage IDs, scope
writes and recording formats must remain readable. Snapshots and retained
success never invoke an adapter or rewrite an existing recording.

`test/preparation-compatibility.test.ts` reopens native captures produced by
commit `1781c22` and verifies their unchanged interpretation and bytes. Only the
external evidence/trace transport paths are relocated into the test directory.
The source/release suites enforce synced intent, immutable binding, captured
adapters, failure privacy and exact native replay.
