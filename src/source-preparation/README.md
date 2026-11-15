# Source preparation

This optional module owns the four native source/package stages before a
separate reviewed deployment. Its public contract is described in
[`docs/source-preparation.md`](../../docs/source-preparation.md).

Keep adapter effects behind `start()`, with synced intent before every call.
Declaration and `snapshot()` must not fetch source, build or publish. Retained
success requires matching immutable definitions, receipts and complete native
JSONL replay; uncertainty blocks automatic retry. The source adapter does not
choose or mutate a deployment target.

The construction file contains the sole four-stage chart. Stage behavior reuses
delivery's source/build/publication primitives. Keep public data admission pure;
Node recording and storage remain in the `/node` entrypoint. Tests in
`test/source-preparation.test.ts` enforce intent ordering, source substitutions,
interruption, immutable receipts, failed downstream work and read-only replay.
