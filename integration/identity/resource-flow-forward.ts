import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { IdentityTarget } from './target.ts';
import { writeNeoFlowJson } from './resource-flow-files.ts';

const execute = promisify(execFile);
const args = (target: IdentityTarget) => ['--kubeconfig', target.kubeconfig, '--context', target.context,
  '--namespace', target.namespace, 'port-forward', 'deployment/neo', `${target.neoPort}:5230`, '--address', '127.0.0.1'];
async function healthy(target: IdentityTarget): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${target.neoPort}/health`, { signal: AbortSignal.timeout(1000) });
    return response.status === 200 && (await response.json() as { status?: string }).status === 'ok';
  } catch { return false; }
}

/** Own only this exact recorded forward. Existing source containers and other app forwards are untouched. */
export async function ensureNeoFlowForward(target: IdentityTarget): Promise<void> {
  const argv = args(target), path = join(target.directory, 'forward.json');
  let previous: { pid?: number; argv?: string[]; context?: string; namespace?: string } | undefined;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous?.pid) {
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 1 || previous.context !== target.context
      || previous.namespace !== target.namespace || JSON.stringify(previous.argv) !== JSON.stringify(argv)) {
      throw Error('The saved app connection belongs to another target');
    }
    let command = '';
    try { command = (await execute('ps', ['-p', String(previous.pid), '-o', 'command='])).stdout.trim(); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (command) {
      const suffix = ' ' + argv.join(' '), executable = command.slice(0, -suffix.length);
      if (!command.endsWith(suffix) || !/(^|\/)kubectl$/.test(executable)) throw Error('The saved app connection process changed');
      if (await healthy(target)) return;
      try { process.kill(previous.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 40; attempt++) {
        try { process.kill(previous.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
        await delay(100);
      }
      try { process.kill(previous.pid, 0); throw Error('The old owned app connection has not stopped'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  const logPath = join(target.directory, 'resource-flow-forward.log'), log = openSync(logPath, 'a', 0o600);
  const offset = (await stat(logPath)).size;
  let child;
  try { child = spawn('kubectl', argv, { detached: true, stdio: ['ignore', log, log] }); }
  finally { closeSync(log); }
  let failure = false; child.once('error', () => { failure = true; });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw Error('The owned app connection failed to open');
      const fresh = (await readFile(logPath)).subarray(offset).toString('utf8');
      if (/address already in use|unable to listen/i.test(fresh)) throw Error('The prepared Neo address is occupied');
      if (fresh.includes(`Forwarding from 127.0.0.1:${target.neoPort} -> 5230`) && await healthy(target)
        && child.exitCode === null && child.signalCode === null && !failure) {
        await writeNeoFlowJson(path, { pid: child.pid, argv, context: target.context, namespace: target.namespace,
          baseUrl: `http://127.0.0.1:${target.neoPort}`, logPath, createdAt: new Date().toISOString() });
        child.unref(); return;
      }
      await delay(200);
    }
    throw Error('The configured Neo consumer is not reachable');
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    child.unref(); throw error;
  }
}
