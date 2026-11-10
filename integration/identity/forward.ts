import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadIdentityTarget } from './target.ts';

const target = await loadIdentityTarget(process.argv[2]);
const logPath = join(target.directory, 'forward.log');
await writeFile(logPath, '', { mode: 0o600 });
const log = openSync(logPath, 'a', 0o600);
const argv = ['--kubeconfig', target.kubeconfig, '--context', target.context, '--namespace', target.namespace,
  'port-forward', 'deployment/neo', `${target.neoPort}:5230`, '--address', '127.0.0.1'];
const child = spawn('kubectl', argv, { detached: true, stdio: ['ignore', log, log] });
closeSync(log);
let spawnError = false; child.once('error', () => { spawnError = true; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw Error('The new identity port-forward failed; inspect its private log');
    const text = await readFile(logPath, 'utf8');
    if (/address already in use|unable to listen/i.test(text)) throw Error('The selected local identity port is occupied');
    if (text.includes(`Forwarding from 127.0.0.1:${target.neoPort} -> 5230`)) {
      const response = await fetch(`http://127.0.0.1:${target.neoPort}/health`, { signal: AbortSignal.timeout(3000) });
      const body = await response.json() as { status?: string };
      if (response.status === 200 && body.status === 'ok') { ready = true; break; }
    }
    await delay(250);
  }
  if (!ready) throw Error('The protected Neo app did not become reachable');
  const data = { pid: child.pid, argv, context: target.context, namespace: target.namespace,
    baseUrl: `http://127.0.0.1:${target.neoPort}`, logPath, createdAt: new Date().toISOString() };
  await writeFile(join(target.directory, 'forward.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  child.unref(); console.log(JSON.stringify(data, null, 2));
} catch (error) { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); child.unref(); throw error; }
