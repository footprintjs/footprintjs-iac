import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { capture, run } from './command.ts';
import { REVIEW_CLUSTER } from './target.ts';

export interface ReviewImages { sourceCommit: string; nodeImage: string; pythonImage: string }

export function reviewImageTag(component: 'node' | 'python', imageId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Expected a complete Docker image sha256 identity');
  return `footprint-iac/neo-${component}:review-${imageId.slice(7)}`;
}

export function loadReviewImages(root: string): ReviewImages {
  const { commit } = JSON.parse(readFileSync(resolve(root, '.artifacts/neo/source.json'), 'utf8'));
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected the committed Neo source identity');
  function tag(component: 'node' | 'python'): string {
    const source = `footprint-iac/neo-${component}:local`;
    const destination = reviewImageTag(component, capture('docker', ['image', 'inspect', '--format', '{{.Id}}', source]));
    run('docker', ['tag', source, destination]);
    return destination;
  }
  const images = { sourceCommit: commit, nodeImage: tag('node'), pythonImage: tag('python') };
  run('kind', ['load', 'docker-image', '--name', REVIEW_CLUSTER, images.nodeImage, images.pythonImage], 240_000);
  writeFileSync(resolve(root, '.artifacts/neo/review-images.json'), JSON.stringify(images, null, 2) + '\n', { mode: 0o600 });
  return images;
}

export function readReviewImages(root: string, sourceCommit: string): ReviewImages {
  const images = JSON.parse(readFileSync(resolve(root, '.artifacts/neo/review-images.json'), 'utf8')) as ReviewImages;
  if (images.sourceCommit !== sourceCommit
    || !/^footprint-iac\/neo-node:review-[a-f0-9]{64}$/.test(images.nodeImage)
    || !/^footprint-iac\/neo-python:review-[a-f0-9]{64}$/.test(images.pythonImage)) {
    throw new Error('Review images do not match the prepared source; rerun npm run neo:setup');
  }
  return images;
}
