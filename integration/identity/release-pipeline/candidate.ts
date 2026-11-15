import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonical } from '../../../src/util.ts';
import { readReleaseManifest } from '../../../src/releases/manifest.ts';
import { readDeliveryPublication } from '../../../src/delivery/data.ts';
import { publicSourceRepository } from '../../../src/delivery/source-identity.ts';
import { identifier } from '../../../src/graph/data.ts';
import { command } from '../command.ts';
import { neoDeliveryHash, neoDeliveryTarget, readNeoDeliveryCandidate, type NeoDeliverySourceReceipt } from '../github-delivery/target.ts';
import { readNeoDeliveryJson, writeNeoDeliveryJson } from '../github-delivery/files.ts';
import type { IdentityTarget } from '../target.ts';
import type { NeoPreparedRelease } from './types.ts';

/** Rebind a proven artifact receipt to the current environment, without rebuilding or editing its sealed manifest. */
export async function bindNeoReleaseCandidate(input: NeoPreparedRelease, buildTarget: IdentityTarget, current: IdentityTarget,
  operationId: string, run: typeof command = command) {
  const release = readReleaseManifest(input.manifest), publication = readDeliveryPublication(input.publication);
  const metadata = publication.metadata;
  if (typeof metadata?.candidatePath !== 'string' || typeof metadata.repository !== 'string' || publicSourceRepository(metadata.repository) !== release.source.repository || metadata.commit !== release.source.commit
    || metadata.tree !== release.source.tree || canonical(publication.artifacts) !== canonical(release.artifacts)) throw Error('Neo publication differs from its sealed manifest');
  const path = resolve(metadata.candidatePath), parent = join(buildTarget.directory,'candidates'), parts = relative(parent,dirname(path)).split(sep);
  if (![1,2].includes(parts.length) || path !== join(parent,...parts,'target.json') || !/^[a-f0-9]{40}$/.test(parts.at(-1)!)
    || (parts.length===2 && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(parts[0]!))) throw Error('Choose a private staged Neo source receipt');
  for (const location of [parent,...(parts.length===2?[join(parent,parts[0]!)]:[]),dirname(path),path,join(dirname(path),'source-review.json')]) {
    if (await realpath(location)!==location || (await lstat(location)).isSymbolicLink()) throw Error('Neo release receipt cannot use symbolic links');
  }
  const sourceTarget = await readNeoDeliveryJson(path) as IdentityTarget;
  const receipt = await readNeoDeliveryJson(join(dirname(path),'source-review.json')) as NeoDeliverySourceReceipt;
  if (canonical(neoDeliveryTarget(sourceTarget))!==canonical(neoDeliveryTarget(buildTarget)) || sourceTarget.sourceCommit!==release.source.commit
    || receipt.baseCommit!==release.source.commit || receipt.sourceTree!==release.source.tree || receipt.sourceTree!==parts.at(-1)
    || receipt.candidateScope!==(parts.length===2?parts[0]:undefined) || !/^[a-f0-9]{64}$/.test(receipt.canonicalTargetSha256)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId) || !/^sha256:[a-f0-9]{64}$/.test(receipt.pythonImageId)) throw Error('Neo source receipt changed');
  for (const [id,field,imageId] of [['node','nodeImage',receipt.imageId],['python','pythonImage',receipt.pythonImageId]] as const) {
    const artifact = release.artifacts.find(artifact=>artifact.id===id);
    if (!artifact || artifact.digest.replace(/^sha256:/,'')!==imageId.slice(7) || artifact.reference!==sourceTarget.images[field]
      || artifact.reference!==`footprint-iac/neo-${id}:identity-`+imageId.slice(7)
      || await run('docker',['image','inspect','--format','{{.Id}}',artifact.reference])!==imageId) throw Error('Neo artifact content differs from its source receipt');
  }
  if (release.artifacts.length!==2 || receipt.image!==sourceTarget.images.nodeImage || receipt.pythonImage!==sourceTarget.images.pythonImage) throw Error('Neo requires exactly its two sealed application images');
  const canonicalBytes = await readFile(join(current.directory,'target.json'),'utf8');
  if (canonical(JSON.parse(canonicalBytes))!==canonical(current)) throw Error('Neo target changed before release binding');
  const target: IdentityTarget = { ...current, images: { ...current.images,nodeImage:receipt.image,pythonImage:receipt.pythonImage }, sourceCommit:release.source.commit,
    ...(sourceTarget.sourceDirectory?{sourceDirectory:sourceTarget.sourceDirectory}:{}) };
  const scope = identifier(operationId,'Neo release operation'), destination = join(current.directory,'candidates',scope,release.source.tree,'target.json');
  try { await lstat(destination); throw Error('Neo release operation already has a staged candidate'); }
  catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  await writeNeoDeliveryJson(destination,target);
  await writeNeoDeliveryJson(join(dirname(destination),'source-review.json'),{...receipt,candidateScope:scope,canonicalTargetSha256:neoDeliveryHash(canonicalBytes)});
  const candidate = await readNeoDeliveryCandidate(destination,current);
  return { candidate, publication:{artifacts:[...release.artifacts],metadata:{candidatePath:destination,repository:release.source.repository,commit:release.source.commit,tree:release.source.tree}} };
}
