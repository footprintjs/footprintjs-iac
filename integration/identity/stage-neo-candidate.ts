import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IdentityTarget } from './target.ts';
import { validateIdentityTarget } from './validate-target.ts';

/** Stage desired images for review; publishing an applied target is a later action. */
export async function stageNeoCandidate(target: IdentityTarget, sourceTree: string, metadata: object, canonicalBytes: string, root: string) {
  validateIdentityTarget(target, root);
  if (!/^[a-f0-9]{40}$/.test(sourceTree)) throw Error('Expected an exact reviewed source tree');
  if (await readFile(join(target.directory, 'target.json'), 'utf8') !== canonicalBytes) {
    throw Error('The applied target changed while the candidate images were building; review it again');
  }
  const parent = join(target.directory, 'candidates'), directory = join(parent, sourceTree);
  await mkdir(parent, { mode: 0o700, recursive: true });
  if ((await lstat(parent)).isSymbolicLink()) throw Error('Candidate directory must not be a symbolic link');
  try { await lstat(directory); throw Error('This reviewed source already has a staged candidate'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(parent, '.building-'));
  const targetPath = join(directory, 'target.json');
  const receipt = { ...metadata, canonicalTargetSha256: createHash('sha256').update(canonicalBytes).digest('hex') };
  try {
    await writeFile(join(staging, 'source-review.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staging, 'target.json'), JSON.stringify(target, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return targetPath;
}
