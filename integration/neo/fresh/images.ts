import { capture, run } from '../setup/command.ts';
import { reviewImageTag } from '../setup/images.ts';

/** Content-derived tags are checked immediately before loading so cached mutable aliases are never deployment inputs. */
export function loadFreshImages(clusterName: string, nodeImageId: string, pythonImageId: string) {
  const nodeImage = reviewImageTag('node', nodeImageId);
  const pythonImage = reviewImageTag('python', pythonImageId);
  for (const [identity, tag] of [[nodeImageId, nodeImage], [pythonImageId, pythonImage]] as const) {
    run('docker', ['tag', identity, tag]);
    if (capture('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]) !== identity) {
      throw new Error('Neo image identity changed while preparing the fresh target');
    }
  }
  run('kind', ['load', 'docker-image', '--name', clusterName, nodeImage, pythonImage], 240_000);
  return { nodeImage, pythonImage };
}
