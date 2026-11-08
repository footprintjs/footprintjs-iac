import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startReviewForward } from '../integration/neo/review/forward.ts';

const fakeKubectl = `#!/usr/bin/env node
const { createServer } = require('node:http');
const { appendFileSync } = require('node:fs');
const preferred = process.argv.includes('15230:5230');
const record = event => appendFileSync(process.env.NEO_FORWARD_EVENTS, JSON.stringify({ event, preferred, pid: process.pid }) + '\\n');
const servers = [];
record('started');
function listen(backendPort) {
  const server = createServer((request, response) => { response.writeHead(200); response.end('healthy'); });
  servers.push(server);
  server.listen(0, '127.0.0.1', () => console.log('Forwarding from 127.0.0.1:' + server.address().port + ' -> ' + backendPort));
}
process.on('SIGTERM', () => { record('terminated'); for (const server of servers) server.close(); process.exit(0); });
if (preferred) {
  console.error('Unable to listen on port 15230: listen tcp4 127.0.0.1:15230: bind: address already in use');
  // Real kubectl stays alive when the Python listener succeeds by itself.
  listen(8000);
} else { listen(5230); listen(8000); }
`;

test('partial preferred-port binding terminates its live child and retries both ports randomly', { timeout: 12_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-forward-'));
  const bin = join(directory, 'bin'); await mkdir(bin);
  const eventsPath = join(directory, 'events.jsonl');
  await writeFile(eventsPath, '');
  await writeFile(join(bin, 'kubectl'), fakeKubectl, { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousEvents = process.env.NEO_FORWARD_EVENTS;
  process.env.PATH = bin + ':' + (previousPath ?? '');
  process.env.NEO_FORWARD_EVENTS = eventsPath;
  const events = async () => (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; preferred: boolean; pid: number });
  t.after(async () => {
    // Every PID came from the executable this test created and launched.
    for (const { pid } of (await events()).filter(event => event.event === 'started')) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousEvents === undefined) delete process.env.NEO_FORWARD_EVENTS; else process.env.NEO_FORWARD_EVENTS = previousEvents;
    await delay(50);
    await rm(directory, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  const forward = await startReviewForward({ context: 'kind-footprint-iac-review', kubeconfig: '/unused/test-config', directory });
  assert.ok(Date.now() - startedAt < 10_000, 'must not wait for the 40-second partial-forward timeout');
  assert.ok(forward.argv.includes(':5230'));
  assert.equal(forward.argv.includes('15230:5230'), false);
  assert.equal((await fetch(forward.baseUrl + '/health')).status, 200);
  assert.equal((await fetch(forward.pythonUrl + '/healthz')).status, 200);
  let recorded = await events();
  for (let attempt = 0; !recorded.some(event => event.preferred && event.event === 'terminated') && attempt < 50; attempt++) {
    await delay(20); recorded = await events();
  }
  assert.deepEqual(recorded.filter(event => event.event === 'started').map(event => event.preferred), [true, false]);
  assert.ok(recorded.some(event => event.preferred && event.event === 'terminated'), 'partial-forward child received termination');
  assert.equal(recorded.find(event => !event.preferred && event.event === 'started')!.pid, forward.pid);
});
