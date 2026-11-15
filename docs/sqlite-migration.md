# Real local SQLite replacement

`footprintjs-iac/migration/sqlite` implements the generic stateful migration ports for an explicitly cooperating local consumer. It uses real SQLite databases and `node:sqlite` on Node.js 24+. It is independent of Neo, Kubernetes and cloud providers. The generic migration workflow contains no SQLite branches.

The adapter runs inspect → quiesce → backup → create candidate → transfer/schema migration → verify data → **manual cutover gate** → switch consumer → verify consumer → retain source/backup → resume writes. It never deletes the source, backup or candidate, and it exposes no automatic pointer rollback.

## Consistency and preservation

The backup is made through `node:sqlite.backup`, which wraps SQLite's backup API. SQLite documents that a completed online backup is a consistent snapshot and explains how concurrent writes affect its copy. The adapter additionally fences cooperating writes for the entire protected migration and manual gate. It does not copy a live database with a filesystem copy command. See the [SQLite backup documentation](https://www.sqlite.org/backup.html) and [Node SQLite API](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options).

The source, backup and candidate are real independently retained files. Measurements read SQLite integrity/foreign-key checks, schema, full logical table contents and the cooperative write sequence. The backup receipt's `sourceSnapshot` comes from an independent measurement of the backup, and must match the fenced source snapshot; its separate digest also binds the backup's physical identity. For data preservation the adapter compares the **exact canonical output of a host-registered invariant reader** for source, backup and candidate. A count match is insufficient. The reader selects and orders every field the application must preserve and rejects domain invariant failures. Hashes summarize the measured records; raw rows and SQL do not enter native migration summaries.

The included conversation fixture preserves all selected user, conversation and message identifiers, ownership links, names, titles, timestamps and message bodies. Version 2 adds a delivery-state field, an index and a schema-version table while preserving the existing records. Its tests corrupt a message without changing row counts and require verification to fail before the pointer switches.

## Cooperating consumer and owned roots

`OwnedSqliteConsumer` registers trusted read/write functions by ID. Each operation resolves its current durable pointer. Writes use prepared parameters, share the migration's local ownership lock, check the durable write fence and increment an internal write sequence in the same SQLite transaction as the application write. The pointer and actual SQLite schema version must agree. Readers can remain available while writes are paused; the default fixture's append action refuses a fenced write.

The host creates an empty private root and initializes it explicitly. Owner identity binds the consumer ID, canonical root and physical directory. Database locations are derived from safe registered IDs under that root. Private files, symlinks, existing destination files, size limits and ownership changes are admitted conservatively; a candidate or backup is never silently overwritten. Browser inputs cannot choose SQL, executable programs, environment variables or database paths.

The filesystem lock and persistent fence are **single-host coordination**, not a distributed lease. They protect cooperating entry points. An external process that opens SQLite directly can ignore the fence; it must be stopped, integrated or otherwise fenced before using this strategy. Gate revalidation detects changed source/backup/candidate snapshots and changed fence identity, but does not make a non-cooperating writer race safe. A database server with distributed writers needs its own supported quiesce/change-capture/cutover adapter.

Capture is intentionally bounded: each admitted database/sidecar is at most 64 MiB; a measurement captures at most 256 tables, 2,048 schema entries, 10,000 total schema/data rows and 4 MiB of encoded capture. It iterates rows and fails before accumulating an unbounded table. Host invariant/read/migration functions remain trusted code, not a sandbox for arbitrary plugins. Larger data needs a streaming verification design and separately validated limits.

## Host composition

The real local fixture creates its initial populated version only in a new empty owned directory. Reopening the same directory preserves the existing database, active pointer and fence; it never reseeds or resets the app.

```ts
import { createSqliteConversationFixture } from 'footprintjs-iac/migration/sqlite';
import {
  MigrationWorkflow, FileMigrationStore, FileMigrationLocks, offlineTransferStrategy,
} from 'footprintjs-iac/migration/node';

const app = await createSqliteConversationFixture({directory: privateApplicationRoot});
const resources = await app.adapter.resources();

// readonlyAssessment is a host-owned ChangeAssessmentWorkflow for this source.
// Its target.scope must be resources.source.scope. Select a known stateful replacement.
const assessed = await readonlyAssessment.start();
if (assessed.status !== 'complete' || !assessed.report) throw Error('Assessment is incomplete');
const change = assessed.report.changes.find(change =>
  change.disposition === 'replace' && change.data === 'stateful');
if (!change) throw Error('No assessed stateful replacement was selected');

const workflow = new MigrationWorkflow({
  definition: {
    version: 1, id: 'reviewed-conversation-schema-v2', label: 'Preserve conversation history',
    assessmentDigest: assessed.report.digest, changeId: change.id,
    configurationDigest: app.adapter.configurationDigest,
    ...resources, strategyId: 'offline-transfer', adapterId: app.adapter.id,
  },
  assessment: assessed.report,
  registry: {strategies: [offlineTransferStrategy()], adapters: [app.adapter]},
  store: new FileMigrationStore(privateAttemptDirectory),
  locks: new FileMigrationLocks(sharedLocalMigrationLockDirectory),
});

const prepared = await workflow.start();
// Show the measured source, retained backup, verified candidate and paused writes.
console.log(await app.readSummary());
if (prepared.pendingAction?.kind !== 'cutover') throw Error('Inspect the retained outcome');

// An authorized human approves this exact host-owned checkpoint.
const {executionId, token, checkpointDigest} = prepared.pendingAction;
const completed = await workflow.cutover({executionId, token, checkpointDigest});
if (completed.status !== 'passed') throw Error('Inspect the active consumer and retained evidence');
await app.appendExampleMessage(); // A real application write follows the candidate pointer.
```

The host keeps the exact definition, assessment presence/report, attempt directory and registered programs when reconstructing a workflow in a different process. Cutover revalidates the durable fence, original physical identity, full source snapshot, backup identity/digest, candidate identity/snapshot and data verification under the consumer's lock. Only then does it atomically replace the active pointer. This protects writes completed before quiescing and refuses stale gate data. A schema migration program runs against the candidate inside a transaction; the original database is not used as the migration target.

For another application, construct `OwnedSqliteConsumer` and `createSqliteMigrationAdapter` directly. Register `sourceDatabaseId`, `targetDatabaseId`, `sourceSchemaVersion`, `targetSchemaVersion`, a migration function, an invariant reader and an actual consumer probe. Functions and their stable IDs/digests are trusted host registrations. Version their digests when their implementation or contract changes; this is not automatic code attestation. Read/write/migration functions must be synchronous and leave transaction management to the wrapper. Consumer probes are asynchronous and read through the actual consumer pointer while the write fence remains held.

`adapter.resources()` supplies the exact generic source/destination handles. `adapter.inspectSource()` returns safe identity/snapshot hashes, schema version, write sequence and counts. The fixture additionally exposes `readSummary()` and `appendExampleMessage()` for a fixed local host action. These are useful to prove that an app reads/writes the candidate after cutover; native infrastructure tracing does not infer application internals from a successful file switch.

## Failure and manual recovery

A verification failure before switching leaves the original consumer active and fenced, with the original source, backup and rejected candidate retained. If the host registered an independent `verifySource` probe, the adapter advertises `verify-recovery` and `resume-source`: an explicit generic recovery gate revalidates the retained checkpoint, reads the old consumer contract and then releases only its exact source fence. Without that probe these recovery capabilities are absent. This is write resumption on the still-active original, not rollback of a switched database.

After a switch, this adapter does not advertise `recover-source` and reports `rollbackCompatible: false`. A failed consumer probe or uncertain outcome requires inspection while retaining the candidate and original artifacts. If writes have resumed, new writes are measured on the candidate; pointing back to the old database would lose them. No automatic rollback is attempted, including when the observed new-write count is zero. Recovery then needs a separately reviewed forward-fix/reconciliation strategy that preserves the actual active data.

Tests cover a real populated v1 database, API backup, v2 schema/data verification, manual pause and continuation in a separate Node process, actual post-cutover consumer reads/writes, exact record preservation, same-count corruption, source/backup/candidate/fence tampering, changed program contracts, bounded capture and parameterized application values. A fault-injection test fails the phase result after resuming and making a real new app write; it verifies that manual rollback is refused and both new writes and all retained files survive. That injected phase verdict is not a claim of a real remote provider outage.

Run the focused test with `node --test test/migration-sqlite.test.ts`. Run the complete core check/test/build before shipping. These local tests change only their owned temporary roots; they do not migrate Neo's current database, contact a cloud provider, dispatch CI or publish code.
