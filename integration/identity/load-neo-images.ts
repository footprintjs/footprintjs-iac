import { join } from 'node:path';
import { canonical } from '../../src/util.ts';
import { command } from './command.ts';
import { identityRoot, loadIdentityTarget, validateIdentityTarget, type IdentityTarget } from './target.ts';

export function identityNeoImageTag(role: 'node' | 'python', imageId: string): string {
  if (!['node', 'python'].includes(role) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw Error('Expected a verified immutable Neo image ID');
  return `footprint-iac/neo-${role}:identity-${imageId.slice('sha256:'.length)}`;
}

/** Trusted test seams; the CLI always uses its admitted local target and PATH executables. */
export interface NeoIdentityImageLoadOptions {
  fixtureRoot?: string;
  loadTarget?: typeof loadIdentityTarget;
  runner?: typeof command;
}

/** Load built immutable images into the same owned cluster admitted before the build. */
export async function loadIdentityNeoImages(input: IdentityTarget, nodeImageId: string, pythonImageId: string,
  options: NeoIdentityImageLoadOptions = {}) {
  const images = { nodeImage: identityNeoImageTag('node', nodeImageId), pythonImage: identityNeoImageTag('python', pythonImageId) };
  const root = options.fixtureRoot ?? identityRoot, target = validateIdentityTarget(input, root);
  const loader = options.loadTarget ?? ((path?: string) => loadIdentityTarget(path, { root }));
  const admitted = validateIdentityTarget(await loader(join(target.directory, 'target.json')), root);
  if (canonical(admitted) !== canonical(target)) throw Error('The prepared identity target changed during the image build');
  await (options.runner ?? command)('kind', ['load', 'docker-image', images.nodeImage, images.pythonImage,
    '--name', target.context.slice('kind-'.length)], 180_000);
  return images;
}
