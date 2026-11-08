import { execFileSync } from 'node:child_process';

export function capture(command: string, args: string[], timeout = 30_000): string {
  return execFileSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }).trim();
}

export function run(command: string, args: string[], timeout = 1_800_000): void {
  execFileSync(command, args, { stdio: 'inherit', timeout });
}

export function preflight(): void {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Neo review requires Node.js 24 or newer');
  capture('git', ['--version']);
  capture('docker', ['info', '--format', '{{.ServerVersion}}']);
  capture('kind', ['version']);
  capture('kubectl', ['version', '--client', '--output=json']);
}
