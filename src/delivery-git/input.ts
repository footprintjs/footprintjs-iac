import { isAbsolute, resolve } from 'node:path';
import type { DeliverySource, SourceRevision } from '../delivery/types.ts';

export function gitRepository(input: string, allowLocal: boolean): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw Error('Configure a credential-free Git repository');
  if (allowLocal && isAbsolute(input)) return resolve(input);
  if (/\s/.test(input)) throw Error('Configure an HTTPS Git repository');
  let url: URL;
  try { url = new URL(input); } catch { throw Error('Configure an HTTPS Git repository'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !url.hostname || url.pathname === '/' || url.pathname.includes('//')) throw Error('Configure a credential-free HTTPS Git repository');
  return url.href;
}
export function gitRef(input: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(input)
    || input.includes('..') || input.includes('//') || input.endsWith('/') || input.endsWith('.')
    || input.split('/').some(part => part.startsWith('.') || part.startsWith('-') || part.endsWith('.lock'))) throw Error('Choose a configured Git revision');
  return input;
}
export function readGitRevision(input: SourceRevision, source: DeliverySource): SourceRevision {
  if (!input || input.repository !== source.repository || input.ref !== source.ref
    || !/^[a-f0-9]{40}$/.test(input.commit) || !/^[a-f0-9]{40}$/.test(input.tree)) throw Error('Git source revision differs from this delivery');
  return { repository: input.repository, ref: input.ref, commit: input.commit, tree: input.tree };
}
export function githubRepository(input: string): string {
  if (typeof input !== 'string') throw Error('Configure a GitHub repository');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) input = 'https://github.com/' + input.replace(/\.git$/, '') + '.git';
  const repository = gitRepository(input, false), url = new URL(repository);
  if (url.hostname !== 'github.com' || url.port || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)
    || url.pathname.split('/').some(part => part === '.' || part === '..')) throw Error('Configure one GitHub owner and repository');
  return 'https://github.com/' + url.pathname.slice(1).replace(/\.git$/, '') + '.git';
}
