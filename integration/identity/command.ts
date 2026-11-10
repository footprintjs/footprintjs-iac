import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Provider output may contain credentials. Never attach stdout/stderr to a captured error. */
export async function command(program: string, args: string[], timeout = 30_000): Promise<string> {
  try { return (await execute(program, args, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error(`${program === 'docker' ? 'Local identity container' : 'Identity fixture'} operation failed`); }
}
