import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IdentityTarget } from '../target.ts';
import type { MasterState, SystemRevision } from '../../../src/master/index.ts';
import { writeNeoDeliveryJson } from './files.ts';
import { assertNeoDeliveryCandidateRevision, readNeoDeliveryCandidate, sameNeoDeliveryTarget, type NeoDeliveryCandidate } from './target.ts';

/** Canonical application bindings are published only after a proven master promotion. */
export async function publishNeoDeliveryTarget(options: {
  current: IdentityTarget; candidate: NeoDeliveryCandidate; revision: SystemRevision; master: MasterState;
  canonicalBytes: string; directory: string;
}): Promise<void> {
  const { current, revision, master, directory } = options;
  const attempt = master.attempts.at(-1);
  if (master.appliedDigest !== revision.digest || attempt?.status !== 'applied' || attempt.revisionDigest !== revision.digest) {
    throw Error('A proven applied master revision is required before publishing Neo bindings');
  }
  const admitted = await readNeoDeliveryCandidate(options.candidate.path, current);
  assertNeoDeliveryCandidateRevision(admitted, revision);
  const candidate = admitted.target;
  const path = join(current.directory, 'target.json'), before = await readFile(path, 'utf8');
  if (before !== options.canonicalBytes && !sameNeoDeliveryTarget(JSON.parse(before), candidate)) throw Error('The canonical Neo target changed');
  const receipt = { revisionDigest: revision.digest, runId: attempt.runId, target: candidate, previousTarget: current };
  await writeNeoDeliveryJson(join(directory, 'publications', revision.digest + '.json'), { ...receipt, status: 'publishing', at: new Date().toISOString() });
  await writeNeoDeliveryJson(path, candidate);
  const latest = join(current.directory, '../latest.json');
  try {
    if ((JSON.parse(await readFile(latest, 'utf8')) as { id?: string }).id === candidate.id) await writeNeoDeliveryJson(latest, candidate);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeNeoDeliveryJson(join(directory, 'publications', revision.digest + '.json'), { ...receipt, status: 'published', at: new Date().toISOString() });
}
