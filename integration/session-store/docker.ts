import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

const exec = promisify(execFile);

export async function testServer(t: TestContext, image: string, port: number, options: string[], command: string[],
  env: Record<string, string>, ready: string[]) {
  const name = 'ic-session-contract-' + randomUUID();
  await exec('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::' + port,
    ...Object.keys(env).flatMap(key => ['--env', key]), ...options, image, ...command],
    { env: { ...process.env, ...env } });
  const cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => { await exec('docker', ['stop', '--time', '1', name]); });
  t.after(() => cleanup.disposeAsync());
  for (let i = 0; ; i++) {
    try {
      await exec('docker', ['exec', name, ...ready]);
      break;
    } catch (error) {
      if (i >= 100) throw error;
      await setTimeout(200);
    }
  }
  const { stdout } = await exec('docker', ['port', name, port + '/tcp']);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(stdout.trim());
  if (!match) throw new Error('Expected an isolated loopback port');
  return { port: Number(match[1]), cleanup };
}
