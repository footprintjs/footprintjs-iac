import { spawn, execFile } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { NEO_NAMESPACE } from '../stack.ts';

const bindFailure = /address already in use|unable to listen on any.*ports/i;

export async function startReviewForward(options: { context: string; kubeconfig: string; directory: string }) {
  async function start(preferred: boolean) {
    const logPath = join(options.directory, preferred ? 'forward.log' : 'forward-random.log');
    const argv = ['--kubeconfig', options.kubeconfig, '--context', options.context, '--namespace', NEO_NAMESPACE,
      'port-forward', 'deployment/neo', preferred ? '15230:5230' : ':5230', ':8000', '--address', '127.0.0.1'];
    const log = openSync(logPath, 'a', 0o600);
    const child = spawn('kubectl', argv, { detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    let spawnError: Error | undefined;
    let output = '';
    child.once('error', error => { spawnError = error; });
    try {
      for (let attempt = 0; attempt < 160; attempt++) {
        if (spawnError) throw spawnError;
        output = await readFile(logPath, 'utf8');
        // kubectl can keep the Python listener alive after the preferred UI
        // port fails to bind. Do not wait for that partial forward to exit.
        if (bindFailure.test(output)) throw new Error(output.trim());
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(output.trim() || `kubectl exited ${child.exitCode ?? child.signalCode}`);
        }
        const ports = new Map<number, number>();
        for (const match of output.matchAll(/Forwarding from 127\.0\.0\.1:(\d+) -> (5230|8000)/g)) ports.set(Number(match[2]), Number(match[1]));
        if (ports.has(5230) && ports.has(8000)) {
          const baseUrl = `http://127.0.0.1:${ports.get(5230)}`;
          const pythonUrl = `http://127.0.0.1:${ports.get(8000)}`;
          for (const url of [`${baseUrl}/health`, `${pythonUrl}/healthz`]) {
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
          }
          const start = await promisify(execFile)('ps', ['-p', String(child.pid), '-o', 'lstart=']);
          const result = { pid: child.pid!, command: 'kubectl', argv, context: options.context,
            kubeconfig: options.kubeconfig, namespace: NEO_NAMESPACE, baseUrl, pythonUrl,
            processStartedAt: start.stdout.trim(), logPath, createdAt: new Date().toISOString() };
          await writeFile(join(options.directory, 'forward.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
          child.unref();
          return result;
        }
        await delay(250);
      }
      throw new Error(`Review port-forward did not become healthy within 40 seconds\n${output.trim()}`);
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      child.unref();
      throw error;
    }
  }
  try { return await start(true); }
  catch (error) {
    if (!bindFailure.test(String(error))) throw error;
    return start(false);
  }
}
