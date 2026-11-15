import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ArtifactStore, BuildAdapter, DeliveryRecipe } from '../../../src/delivery/types.ts';
import { canonical } from '../../../src/util.ts';
import { buildNeoImages } from '../build-neo-images.ts';
import { loadIdentityNeoImages } from '../load-neo-images.ts';
import { command } from '../command.ts';
import type { IdentityTarget } from '../target.ts';
import { identityPackageRoot } from '../paths.ts';
import { neoDeliveryArtifacts, readNeoDeliveryCandidate } from './target.ts';
import type { NeoGithubDeliveryOptions } from './types.ts';

export async function neoDeliveryRecipe(): Promise<DeliveryRecipe> {
  const files = ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(resolve(identityPackageRoot, 'integration/neo', file)));
  return { id: 'neo-node-python-images', digest: hash.digest('hex') };
}

export function neoDeliveryBuildAdapters(options: NeoGithubDeliveryOptions, target: IdentityTarget,
  recipe: DeliveryRecipe): { build: BuildAdapter; artifacts: ArtifactStore } {
  const build: BuildAdapter = { async build(source, selectedRecipe, context) {
    if (selectedRecipe.id !== recipe.id || selectedRecipe.digest !== recipe.digest
      || (await neoDeliveryRecipe()).digest !== recipe.digest
      || source.revision.repository !== options.source.repository || source.revision.ref !== options.source.ref) {
      throw Error('Neo delivery source or build recipe changed');
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', source.location, ...args], { encoding: 'utf8' }).trim();
    if (git('rev-parse', 'HEAD') !== source.revision.commit || git('write-tree') !== source.revision.tree
      || git('diff', '--name-only') || git('diff', '--cached', '--name-only')) throw Error('Fetched Neo source does not match the pinned GitHub commit');
    const result = await (options.buildImages ?? buildNeoImages)(source.location, source.revision.tree, options.targetPath,
      { ...options.buildOptions, stageOnly: true, deferImageLoad: true, candidateScope: context.executionId });
    if (result.baseCommit !== source.revision.commit || result.sourceTree !== source.revision.tree || !result.stageOnly) {
      throw Error('Neo build did not produce the pinned source version');
    }
    const candidate = await readNeoDeliveryCandidate(result.targetPath, target);
    return { recipeDigest: recipe.digest, artifacts: neoDeliveryArtifacts(candidate.target),
      metadata: { candidatePath: candidate.path, repository: source.revision.repository,
        commit: source.revision.commit, tree: source.revision.tree } };
  } };
  const artifacts: ArtifactStore = { async publish(result) {
    if (result.recipeDigest !== recipe.digest || typeof result.metadata?.candidatePath !== 'string') throw Error('Choose the recorded Neo build');
    const candidate = await readNeoDeliveryCandidate(result.metadata.candidatePath, target);
    const expected = neoDeliveryArtifacts(candidate.target);
    if (canonical(result.artifacts) !== canonical(expected)) throw Error('Neo package identities differ from their source receipt');
    const run = options.buildOptions?.runner ?? command;
    for (const artifact of expected) {
      const observed = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', artifact.reference]);
      if (observed !== 'sha256:' + artifact.digest) throw Error('A built Neo image no longer matches its content digest');
    }
    await loadIdentityNeoImages(target, candidate.receipt.imageId, candidate.receipt.pythonImageId, {
      fixtureRoot: options.buildOptions?.fixtureRoot, loadTarget: options.buildOptions?.loadTarget, runner: run,
    });
    return { artifacts: expected, metadata: result.metadata };
  } };
  return { build, artifacts };
}
