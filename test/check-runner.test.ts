import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { CheckRunnerRegistry, CommandCheckAdapter, HttpCheckAdapter, CheckWorkflow, FileCheckStore, loadCheckRecording,
  parsePlaywrightReport, playwrightCheckAdapter, type CheckRequest, type CheckRunner, type CheckSuite } from '../src/checks/node.ts';
import { checkStatus, readCheckRequest, readCheckResult } from '../src/checks/index.ts';

const suite: CheckSuite = { id: 'access', label: 'Login and permissions', digest: 'a'.repeat(64), kind: 'http' };
const request: CheckRequest = { invocationId: 'run-1', suiteId: suite.id, suiteDigest: suite.digest,
  releaseId: 'app-v2', releaseDigest: 'b'.repeat(64), stageId: 'gamma', target: { id: 'local', scope: 'namespace/gamma' }, reason: 'after-deploy' };
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), 'iac-check-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('real localhost HTTP adapter records connected, failed and recovered measurements without response bodies', async t => {
  let healthy = true; const secret = 'SECRET-RESPONSE-MUST-NOT-RECORD';
  const server = createServer((_req, res) => { res.statusCode = healthy ? 200 : 503; res.end(healthy ? 'ready:' + secret : 'down:' + secret); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runner = new HttpCheckAdapter({ id: 'http', suites: [{ ...suite, requests: [{ id: 'login', url: `http://127.0.0.1:${address.port}/ready`, bodyIncludes: 'ready:' }] }] });
  const root = await directory(t), statuses: string[] = [];
  for (const [index, status] of ['passed','failed','passed'].entries()) {
    healthy = index !== 1;
    const workflow = new CheckWorkflow({ runner, request: { ...request, invocationId: 'run-' + index }, store: new FileCheckStore(join(root, String(index))) });
    const state = await workflow.start(); assert.equal(state.status, status); statuses.push(state.status);
    assert.equal(state.result!.checks[0]!.statusCode, healthy ? 200 : 503);
    const recording = await loadCheckRecording(state.recording!.evidencePath, { runId: state.recording!.runId });
    const log = readStoredRecord(readRecordFile(state.recording!.tracePath).entries).root(state.recording!.runId)!;
    assert.equal(log.complete, true); assert.deepEqual(log.gaps, []);
    assert.deepEqual(stateAt(log, log.commitLog.length - 1).state, (recording.snapshot as {sharedState: unknown}).sharedState);
    assert.ok(log.commitLog.length >= 2);
    for (const path of [state.recording!.evidencePath, state.recording!.tracePath]) {
      const bytes = await readFile(path, 'utf8'); assert.equal(bytes.includes(secret), false); assert.equal(bytes.includes('/ready'), false);
    }
    assert.deepEqual(await workflow.start(), state, 'reopening does not repeat HTTP work');
  }
  assert.deepEqual(statuses, ['passed','failed','passed']);
});

test('registered command adapter executes a real hermetic test process and preserves bounded failures', async t => {
  const root = await directory(t), script = join(root, 'suite.mjs');
  await writeFile(script, 'process.stdout.write(JSON.stringify({checks:[{id:"allowed",status:"passed"},{id:"denied",status:process.argv[2]}]})); if(process.argv[2]!=="passed")process.exitCode=1;');
  for (const status of ['passed','failed','skipped','inconclusive'] as const) {
    const runner = new CommandCheckAdapter({ id: 'cli', suites: [{ ...suite, kind: 'command', command: { program: process.execPath, args: [script, status] } }] });
    const result = await runner.run(request); assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes(script), false);
  }
  const crash = new CommandCheckAdapter({ id: 'crash', suites: [{ ...suite, command: { program: process.execPath, args: ['-e', 'throw Error("PRIVATE-PROCESS-SECRET")'] } }] });
  const error = await crash.run(request); assert.equal(error.status, 'error'); assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
});

test('check registry rejects floating suites and forged release bindings, and only all-passed results are eligible', async () => {
  let calls = 0;
  const runner: CheckRunner = { id: 'external', suites: () => [suite], async run(input) { calls++; return { request: input, status: 'passed', checks: [{ id: 'one', status: 'passed' }] }; } };
  const registry = new CheckRunnerRegistry([runner]);
  await assert.rejects(() => registry.run('external', { ...request, suiteDigest: 'c'.repeat(64) }), /suite/); assert.equal(calls, 0);
  await assert.rejects(() => registry.run('external', { ...request, command: 'sh' } as CheckRequest), /data/); assert.equal(calls, 0);
  assert.equal((await registry.run('external', request)).status, 'passed');
  runner.run = async input => ({ request: { ...input, releaseDigest: 'c'.repeat(64) }, status: 'passed', checks: [{ id: 'one', status: 'passed' }] });
  await assert.rejects(() => registry.run('external', request), /different release/);
  for (const status of ['error','failed','inconclusive','skipped'] as const) assert.notEqual(checkStatus([{ status: 'passed' }, { status }]), 'passed');
  assert.throws(() => readCheckResult({ request, status: 'passed', checks: [{ id: 'one', status: 'skipped' }] }), /aggregate/);
  assert.throws(() => readCheckRequest({ ...request, url: 'http://attacker' }), /data/);
  assert.throws(() => readCheckResult({ request, status: 'passed', checks: [{ id: 'one', status: 'passed' }], artifacts: [{ id: 'trace', digest: 'a'.repeat(64), reference: 'https://files.invalid/report?token=private' }] }), /secret/);
  assert.throws(() => readCheckResult({ request, status: 'passed', checks: [{ id: 'one', status: 'passed' }], artifacts: [{ id: 'trace', digest: 'a'.repeat(64), reference: 'javascript:alert(1)' }] }), /secret/);
});

test('native check intent precedes the tool, completed evidence is bound, and uncertain invocations cannot rerun', async t => {
  const root = await directory(t), store = new FileCheckStore(root); let calls = 0;
  const runner: CheckRunner = { id: 'external', suites: () => [suite], async run(input) {
    assert.equal((await store.load())!.status, 'running'); calls++;
    return { request: input, status: 'passed', checks: [{ id: 'one', status: 'passed' }], receipt: { runId: 'external-run', evidencePath: '/private/secret-report', tracePath: '/private/secret-trace' } };
  } };
  const workflow = new CheckWorkflow({ runner, request, store }), state = await workflow.start();
  assert.equal(state.status, 'passed'); assert.equal(calls, 1); assert.deepEqual(await workflow.start(), state); assert.equal(calls, 1);
  const bytes = await readFile(state.recording!.evidencePath, 'utf8'); assert.equal(bytes.includes('/private/secret-'), false);
  const changed = structuredClone(state); changed.result!.checks[0]!.id = 'forged'; await writeFile(store.path, JSON.stringify(changed));
  await assert.rejects(() => workflow.snapshot(), /differs/); assert.equal(calls, 1);
  await assert.rejects(() => new CheckWorkflow({ runner, request: { ...request, releaseId: 'different' }, store }).start(), /binding changed/);
  const uncertain = { ...state, status: 'running' as const }; delete uncertain.result; delete uncertain.recording;
  await store.save(uncertain); await assert.rejects(() => workflow.start(), /uncertain/); assert.equal(calls, 1);
});

test('Playwright adapter has an explicit fixed-suite contract and parses real reporter shapes without claiming browser execution', async () => {
  const report = JSON.stringify({ suites: [{ specs: [{ tests: [{ status: 'expected', results: [{ status: 'passed' }] }, { status: 'unexpected', results: [{ status: 'failed' }] }] }] }] });
  assert.deepEqual(parsePlaywrightReport(report).map(check => check.status), ['passed','failed']);
  assert.equal(parsePlaywrightReport('{"suites":[]}')[0]!.status, 'inconclusive');
  assert.equal(parsePlaywrightReport(JSON.stringify({ suites: [{ specs: [{ tests: [{ status: 'expected', results: [{ status: 'failed' }] }] }] }] }))[0]!.status, 'inconclusive');
  let observed: unknown;
  const runner = playwrightCheckAdapter({ id: 'browser', cli: '/trusted/node_modules/.bin/playwright', cwd: '/trusted/app',
    suites: [{ ...suite, kind: 'playwright', suite: 'tests/access.spec.ts', project: 'chromium' }],
    driver: async command => { observed = command; return { exitCode: 1, stdout: report }; } });
  assert.equal((await runner.run(request)).status, 'failed');
  assert.deepEqual((observed as {args: string[]}).args, ['test','tests/access.spec.ts','--reporter=json','--workers=1','--project=chromium']);
  await assert.rejects(() => runner.run({ ...request, suiteId: 'unregistered' }), /configured/);
});
