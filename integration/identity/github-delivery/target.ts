import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonical } from '../../../src/util.ts';
import { defineSystemRevision, readSystemRevision, type MasterTarget, type SystemRevision } from '../../../src/master/index.ts';
import type { DeliveryArtifact } from '../../../src/delivery/types.ts';
import { createIdentityGraph } from '../graph.ts';
import type { IdentityTarget } from '../target.ts';

export interface NeoDeliverySourceReceipt {
  baseCommit: string; sourceTree: string; imageId: string; image: string;
  pythonImageId: string; pythonImage: string; canonicalTargetSha256: string;
  candidateScope?: string;
}
export interface NeoDeliveryCandidate { target: IdentityTarget; receipt: NeoDeliverySourceReceipt; path: string }
export const neoDeliveryHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const sameNeoDeliveryTarget = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

/** Application image changes do not change the fixed ownership/connection binding. */
export function neoDeliveryTarget(target: IdentityTarget): MasterTarget {
  const { images, sourceCommit: _commit, sourceDirectory: _source, ...binding } = target;
  return { id: target.id, scope: neoDeliveryHash(canonical({ ...binding,
    images: { ldapImage: images.ldapImage, providerImage: images.providerImage } })) };
}

export function neoDeliveryArtifacts(target: IdentityTarget): DeliveryArtifact[] {
  return (['node', 'python'] as const).map(id => {
    const reference = target.images[id === 'node' ? 'nodeImage' : 'pythonImage'];
    const match = reference.match(/(?:sha256:|(?:review|identity)-)([a-f0-9]{64})$/);
    if (!match) throw Error('Neo releases require content-addressed application images');
    return { id, reference, digest: match[1]! };
  });
}

/** Admit only an already-staged candidate under this exact prepared target. */
export async function readNeoDeliveryCandidate(path: string, current: IdentityTarget): Promise<NeoDeliveryCandidate> {
  path = resolve(path);
  const directory = dirname(path), parent = join(current.directory, 'candidates');
  const parts = relative(parent, directory).split(sep), tree = parts.at(-1)!;
  const candidateScope = parts.length === 2 ? parts[0] : undefined;
  if (![1, 2].includes(parts.length) || !/^[a-f0-9]{40}$/.test(tree)
    || (candidateScope !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(candidateScope))
    || directory !== join(parent, ...(candidateScope === undefined ? [] : [candidateScope]), tree)
    || path !== join(directory, 'target.json')) throw Error('Choose a candidate staged for this Neo target');
  for (const location of [parent, ...(candidateScope === undefined ? [] : [join(parent, candidateScope)]), directory, path, join(directory, 'source-review.json')]) {
    if (await realpath(location) !== location || (await lstat(location)).isSymbolicLink()) throw Error('Neo candidate files cannot be symbolic links');
  }
  const candidate = JSON.parse(await readFile(path, 'utf8')) as IdentityTarget;
  const receipt = JSON.parse(await readFile(join(directory, 'source-review.json'), 'utf8')) as NeoDeliverySourceReceipt;
  if (!candidate || typeof candidate !== 'object' || !candidate.images || typeof candidate.images !== 'object'
    || Object.keys(candidate).some(key => !Object.hasOwn(current, key) && !['sourceCommit', 'sourceDirectory'].includes(key))
    || Object.keys(candidate.images).sort().join(',') !== 'ldapImage,nodeImage,providerImage,pythonImage'
    || Object.entries(current).some(([key, value]) => !['images', 'sourceCommit', 'sourceDirectory'].includes(key)
      && canonical((candidate as unknown as Record<string, unknown>)[key]) !== canonical(value))
    || candidate.images.ldapImage !== current.images.ldapImage || candidate.images.providerImage !== current.images.providerImage
    || (candidate.sourceDirectory !== undefined && (typeof candidate.sourceDirectory !== 'string' || !candidate.sourceDirectory.startsWith('/')
      || /[\x00-\x1f\x7f]/.test(candidate.sourceDirectory)))
    || !/^[a-f0-9]{40}$/.test(candidate.sourceCommit ?? '') || !receipt || receipt.sourceTree !== tree
    || receipt.baseCommit !== candidate.sourceCommit || receipt.candidateScope !== candidateScope || !/^[a-f0-9]{64}$/.test(receipt.canonicalTargetSha256)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId) || !/^sha256:[a-f0-9]{64}$/.test(receipt.pythonImageId)
    || receipt.image !== candidate.images.nodeImage || receipt.pythonImage !== candidate.images.pythonImage
    || receipt.image !== 'footprint-iac/neo-node:identity-' + receipt.imageId.slice(7)
    || receipt.pythonImage !== 'footprint-iac/neo-python:identity-' + receipt.pythonImageId.slice(7)) {
    throw Error('Neo candidate does not match its source receipt or existing ownership');
  }
  const canonicalBytes = await readFile(join(current.directory, 'target.json'), 'utf8');
  if (neoDeliveryHash(canonicalBytes) !== receipt.canonicalTargetSha256 && !sameNeoDeliveryTarget(JSON.parse(canonicalBytes), candidate)) {
    throw Error('The applied target changed after this candidate was built');
  }
  return { target: candidate, receipt, path };
}

export function neoInitialDeliveryRevision(target: IdentityTarget, repository: string): SystemRevision {
  const graph = createIdentityGraph(target, { includeNeo: true });
  return defineSystemRevision({ revisionId: 'neo-initial-' + graph.digest.slice(0, 12), parentDigest: null,
    target: neoDeliveryTarget(target), graph, artifacts: neoDeliveryArtifacts(target),
    source: { repository, ...(target.sourceCommit ? { commit: target.sourceCommit } : {}) } });
}

export function neoCandidateDeliveryRevision(candidate: NeoDeliveryCandidate, repository: string, parentDigest: string): SystemRevision {
  const artifacts = neoDeliveryArtifacts(candidate.target);
  const revisionId = 'neo-' + neoDeliveryHash(canonical({ repository, commit: candidate.receipt.baseCommit,
    tree: candidate.receipt.sourceTree, artifacts, parentDigest, target: neoDeliveryTarget(candidate.target) }));
  return defineSystemRevision({ revisionId, parentDigest,
    target: neoDeliveryTarget(candidate.target), graph: createIdentityGraph(candidate.target, { includeNeo: true }),
    source: { repository, commit: candidate.receipt.baseCommit, tree: candidate.receipt.sourceTree }, artifacts });
}

/** The files reread after review must describe exactly the sealed source, artifacts and provider graph. */
export function assertNeoDeliveryCandidateRevision(candidate: NeoDeliveryCandidate, input: SystemRevision): void {
  const revision = readSystemRevision(input);
  if (canonical(neoDeliveryTarget(candidate.target)) !== canonical(revision.target)
    || createIdentityGraph(candidate.target, { includeNeo: true }).digest !== revision.graph.digest
    || canonical(neoDeliveryArtifacts(candidate.target)) !== canonical(revision.artifacts)
    || revision.source?.commit !== candidate.receipt.baseCommit || revision.source.tree !== candidate.receipt.sourceTree
    || candidate.target.sourceCommit !== candidate.receipt.baseCommit) {
    throw Error('Neo candidate no longer matches the sealed source, artifacts and deployment revision');
  }
}
