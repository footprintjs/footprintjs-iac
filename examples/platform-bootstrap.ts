import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sliceToJSON } from 'foottrace';
import { ExistingClusterAdapter, PlatformClusterWorkflow, type BootstrapIntent } from '../src/platform/index.ts';
import { backwalk, loadEvidence, replay } from '../src/evidence.ts';
import { fixtureClusterProfile, fixtureScope } from './platform-fixture/connection.ts';
import { createPlatformFixture } from './platform-fixture/create-fixture.ts';
import { fixtureWorkflowOptions } from './platform-fixture/workflow-options.ts';

const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw Error('Usage: node examples/platform-bootstrap.ts /private/new-output-directory');
const directory = resolve(destination);
await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 }); // Refuse reuse: existing executions and receipts are never overwritten.
console.log('CONTROLLED FIXTURE: no SSH, no shell execution, no real cluster or server changes.');
const fixture = createPlatformFixture(), profiles: { id: string; label: string }[] = [];
const options = fixtureWorkflowOptions({ ...fixture, directory: join(directory, 'create'), profiles });
const paused = await new PlatformClusterWorkflow(options).start();
assert.equal(paused.status, 'paused');
assert.deepEqual(fixture.control.actions, ['prepare-fixture-host', 'initialize-fixture-cluster', 'configure-fixture-network']);
assert.equal(fixture.control.connects, 0);
await writeFile(join(directory, 'paused.json'), JSON.stringify(paused, null, 2) + '\n', { mode: 0o600 });
console.log('Create reached a native human pause after preparation, initialization and CNI configuration.');
profiles.push(fixtureClusterProfile); // Simulate an operator publishing a new immutable profile in a separate broker.
const created = await new PlatformClusterWorkflow(options).resume({ pauseToken: paused.bootstrap.pause!.token, profileId: fixtureClusterProfile.id });
assert.equal(created.status, 'passed'); assert.equal(fixture.control.actions.length, 3);
console.log('Reopened and resumed the exact checkpoint; installation did not repeat.');

const findIntent: BootstrapIntent = { id: fixture.intent.id, mode: 'existing', topology: { version: fixture.intent.topology.version, nodes: [] } };
const existing = new ExistingClusterAdapter({ id: 'fixture-existing-cluster', scope: fixtureScope, intent: findIntent,
  connection: { ...fixture.connection, async publishAccess() { return { profileId: fixtureClusterProfile.id }; } } });
const beforeFind = fixture.control.actions.length;
const found = await new PlatformClusterWorkflow(fixtureWorkflowOptions({ directory: join(directory, 'find'), intent: findIntent,
  lifecycle: existing, control: fixture.control, profiles })).start();
assert.equal(found.status, 'passed'); assert.deepEqual(found.bootstrap.facts, []); assert.equal(found.bootstrap.actions.length, 0);
assert.equal(fixture.control.actions.length, beforeFind, 'Find does not invoke an installer');

const beforeReplay = JSON.stringify(fixture.control);
const assessment = await loadEvidence(created.bootstrap.recordings[0]!.evidencePath);
const execution = await loadEvidence(created.bootstrap.recordings[1]!.evidencePath);
assert.deepEqual(replay(assessment).state, assessment.snapshot.sharedState);
const planWalk = sliceToJSON(backwalk(assessment, 'plan').slice);
const actionWalk = sliceToJSON(backwalk(execution, 'receipt:initialize-fixture-cluster').slice);
assert.ok(Object.keys(planWalk.nodes!).some(id => id.startsWith('discover#')));
for (const prefix of ['refresh-initialize-fixture-cluster#', 'revalidate-initialize-fixture-cluster#', 'intent-initialize-fixture-cluster#']) {
  assert.ok(Object.keys(actionWalk.nodes!).some(id => id.startsWith(prefix)), prefix);
}
assert.equal(JSON.stringify(fixture.control), beforeReplay, 'public evidence replay/backwalk invokes no adapter');
await writeFile(join(directory, 'plan-backwalk.json'), JSON.stringify(planWalk, null, 2) + '\n', { mode: 0o600 });
await writeFile(join(directory, 'action-backwalk.json'), JSON.stringify(actionWalk, null, 2) + '\n', { mode: 0o600 });
const summary = { kind: 'controlled-platform-demonstration', simulation: true, productionReadiness: 'not-tested', hostChanges: false,
  create: { status: created.status, actionOrder: fixture.control.actions, resumedFromRunId: created.bootstrap.recordings[2]?.resumedFromRunId,
    recordings: created.bootstrap.recordings, connection: created.connection?.segments },
  find: { status: found.status, requestedVersion: findIntent.topology.version, hostCount: 0, discoveryPortRequired: false, installerActions: found.bootstrap.actions,
    recordings: found.bootstrap.recordings, connection: found.connection?.segments },
  observations: { inventoryCalls: fixture.control.inventoryCalls, clusterInspections: fixture.control.inspections, connections: fixture.control.connects },
  readOnlyBackwalk: true, directory };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
