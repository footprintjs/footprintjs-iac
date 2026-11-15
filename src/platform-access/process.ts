import { spawn } from 'node:child_process';
import { HostAccessError } from './error.ts';
import type { HostProcessRunner } from './types.ts';

/** Owned process-group execution with no inherited application/credential environment. */
export const runHostProcess: HostProcessRunner = request => new Promise((resolve, reject) => {
  if (process.platform === 'win32') { reject(new HostAccessError('host-access-unavailable')); return; }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(request.file, [...request.args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
  } catch { reject(new HostAccessError('host-access-unavailable')); return; }
  let bytes = 0, stopped = false;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const stop = () => {
    if (stopped) return; stopped = true;
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  };
  const timer = setTimeout(stop, request.timeoutMs);
  const accept = (parts: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > request.maxOutputBytes) stop(); else parts.push(Buffer.from(chunk));
  };
  child.stdout?.on('data', accept(stdout)); child.stderr?.on('data', accept(stderr));
  child.stdin?.on('error', () => undefined);
  child.once('error', () => { clearTimeout(timer); stop(); reject(new HostAccessError('host-access-unavailable')); });
  child.once('close', code => {
    clearTimeout(timer);
    if (stopped || code === null) reject(new HostAccessError('host-access-unavailable'));
    else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
  child.stdin?.end(request.input);
});
