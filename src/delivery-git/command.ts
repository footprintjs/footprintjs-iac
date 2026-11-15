import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type GitRunner = (args: readonly string[], options: { cwd?: string }) => Promise<string>;
const execute = promisify(execFile);
/** Credentials stay with the host Git credential helper; raw process errors never enter recordings. */
export const runGit: GitRunner = async (args, options) => {
  try {
    const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...args], {
      ...options, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
    });
    return result.stdout.trim();
  } catch { throw Error('The configured Git operation could not be verified. Check repository access in the host Git client.'); }
};
