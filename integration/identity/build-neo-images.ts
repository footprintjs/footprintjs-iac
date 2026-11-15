import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identityRoot, loadIdentityTarget, type IdentityTarget } from './target.ts';
import { command } from './command.ts';
import { describeSourceReview } from './source-review.ts';
import { identityNeoImageTag, loadIdentityNeoImages } from './load-neo-images.ts';
import { stageNeoCandidate } from './stage-neo-candidate.ts';
import { identityPackageRoot } from './paths.ts';

/** Trusted build/test seams; no dashboard request supplies these dependencies. */
export interface NeoImageBuildOptions {
  stageOnly?: boolean;
  /** Delivery workflows publish to the admitted cluster in a separate recorded stage. */
  deferImageLoad?: boolean;
  /** Optional immutable delivery execution namespace; legacy callers keep tree-only staging. */
  candidateScope?: string;
  fixtureRoot?: string;
  loadTarget?: (path?: string) => Promise<IdentityTarget>;
  runner?: typeof command;
}

export async function buildNeoImages(checkout: string, sourceTree: string, targetPath?: string, options: NeoImageBuildOptions = {}) {
  checkout = resolve(checkout);
  if (!/^[a-f0-9]{40}$/.test(sourceTree)) throw Error('Expected an exact reviewed source tree');
  if (options.candidateScope !== undefined && (!options.stageOnly || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.candidateScope))) {
    throw Error('A candidate scope requires a safe immutable staged delivery');
  }
  const root = options.fixtureRoot ?? identityRoot;
  const loader = options.loadTarget ?? ((path?: string) => loadIdentityTarget(path, { root }));
  const target = await loader(targetPath), run = options.runner ?? command;
  const canonicalPath = join(target.directory, 'target.json');
  const canonicalBytes = await readFile(canonicalPath, 'utf8');
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  if (git('write-tree') !== sourceTree) throw new Error('The index no longer matches the reviewed source tree');
  if (git('diff', '--name-only')) throw new Error('Stage the reviewed changes; unstaged tracked files make the build ambiguous');
  const baseCommit = git('rev-parse', 'HEAD');
  const sourceReview = describeSourceReview({ baseCommit, committedTree: git('rev-parse', baseCommit + '^{tree}'), sourceTree });
  const files = execFileSync('git', ['-C', checkout, 'ls-tree', '-rz', '--name-only', sourceTree], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (files.some(path => {
    const leaf = path.split('/').at(-1)!;
    return leaf !== '.env.example' && (leaf === '.env' || leaf === '.npmrc' || leaf.startsWith('.env.') || /\.env$|\.(pem|key)$/.test(leaf) || /(^|\/)\.claude\/settings\.json$/.test(path));
  })) throw new Error('Credential/config material is refused in the reviewed build context');
  const source = JSON.parse(git('show', sourceTree + ':package.json')) as { name: string };
  if (source.name !== 'seo-agentfootprint') throw new Error('Expected the Neo application');
  const scope = options.candidateScope === undefined ? undefined : createHash('sha256')
    .update(JSON.stringify({ target: target.id, scope: options.candidateScope, tree: sourceTree, commit: baseCommit })).digest('hex');
  const sourceKey = scope === undefined ? sourceTree : scope + '-' + sourceTree;
  const context = join(target.directory, 'neo-context-' + sourceKey);
  await mkdir(join(context, '.iac'), { recursive: true, mode: 0o700 });
  const archive = join(target.directory, 'neo-source-' + sourceKey + '.tar');
  git('archive', '--format=tar', '--output=' + archive, sourceTree);
  await run('tar', ['-xf', archive, '-C', context]);
  for (const file of ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py']) await copyFile(resolve(identityPackageRoot, 'integration/neo', file), join(context, '.iac', file));
  const packaging: Record<string, string> = {};
  for (const file of ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py']) packaging[file] = createHash('sha256').update(await readFile(join(context, '.iac', file))).digest('hex');
  await writeFile(join(target.directory, 'source-build-intent.json'), JSON.stringify({ ...sourceReview, packaging, context, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(context, '.dockerignore'), '.git\n**/node_modules\n**/.env\n**/.env.*\n**/.artifacts\n.claude\n.codex\n**/.venv\n', { mode: 0o600 });
  const temporaryTag = `footprint-iac/neo-node:identity-build-${scope ?? target.id}`;
  await run('docker', ['build', '-f', join(context, '.iac/Node.Dockerfile'), '-t', temporaryTag, context], 600_000);
  const imageId = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', temporaryTag]);
  const image = identityNeoImageTag('node', imageId);
  await run('docker', ['tag', imageId, image]);
  const pythonTemporary = `footprint-iac/neo-python:identity-build-${scope ?? target.id}`;
  await run('docker', ['build', '--build-arg', 'NEO_NODE_IMAGE=' + image, '-f', join(context, '.iac/Python.Dockerfile'), '-t', pythonTemporary, context], 600_000);
  const pythonId = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', pythonTemporary]);
  const pythonImage = identityNeoImageTag('python', pythonId);
  await run('docker', ['tag', pythonId, pythonImage]);
  if (!options.deferImageLoad) await loadIdentityNeoImages(target, imageId, pythonId, { fixtureRoot: root, loadTarget: loader, runner: run });
  target.images.nodeImage = image;
  target.images.pythonImage = pythonImage;
  target.sourceDirectory = checkout;
  target.sourceCommit = baseCommit;
  const metadata = { ...sourceReview, imageId, image, pythonImageId: pythonId, pythonImage, packaging, files: files.length };
  if (options.stageOnly) {
    const candidatePath = await stageNeoCandidate(target, sourceTree, metadata, canonicalBytes, root, options.candidateScope);
    return { ...metadata, targetPath: candidatePath, stageOnly: true };
  }
  for (const name of ['source-review.json', 'source-review-' + sourceTree + '.json']) await writeFile(join(target.directory, name), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  await writeFile(canonicalPath, JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
  const latest = join(target.directory, '../latest.json');
  if ((JSON.parse(await readFile(latest, 'utf8')) as { id: string }).id === target.id) await writeFile(latest, JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
  return { ...metadata, targetPath: join(target.directory, 'target.json'), stageOnly: false };
}
