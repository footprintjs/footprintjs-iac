import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preflight, run } from './setup/command.ts';
import { ensureReviewCluster } from './setup/cluster.ts';
import { loadReviewImages } from './setup/images.ts';
import { REVIEW_CONTEXT, reviewTarget } from './setup/target.ts';
import { runNeoReview } from './run-review.ts';

/** Explicit composition root for the portable local fixture, without app source edits. */
export async function setupNeo(sourceDirectory: string) {
  if (!sourceDirectory || sourceDirectory.startsWith('-')) throw new Error('Supply the path to a clean Neo Git checkout');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const target = reviewTarget(root, REVIEW_CONTEXT);
  preflight();
  run(process.execPath, [resolve(root, 'integration/neo/build.mjs'), resolve(sourceDirectory)]);
  ensureReviewCluster(target.kubeconfig);
  loadReviewImages(root);
  return runNeoReview(REVIEW_CONTEXT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: npm run neo:setup -- /path/to/neo-agentfootprint');
  await setupNeo(process.argv[2]!);
}
