import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command } from '../command.ts';
import { readNeoDeliveryJson, writeNeoDeliveryJson } from '../github-delivery/files.ts';
import type { DeliveryArtifact } from '../../../src/delivery/types.ts';

/** Docker's artifact identity can differ from the runtime OCI config ID. Read the immutable archive's Config. */
export async function neoImageConfigDigest(artifact: DeliveryArtifact, options: {directory: string; runner?: typeof command}): Promise<string> {
  const run = options.runner ?? command, expected = 'sha256:' + artifact.digest.replace(/^sha256:/,''), cache = join(options.directory, expected.slice(7)+'.json');
  const inspect = () => run('docker',['image','inspect','--format','{{.Id}}',artifact.reference]);
  if (await inspect() !== expected) throw Error('Neo source image identity differs from its sealed artifact');
  try {
    const receipt = await readNeoDeliveryJson(cache) as {artifactId:string;configDigest:string;config:string};
    if (receipt.artifactId !== expected || !/^sha256:[a-f0-9]{64}$/.test(receipt.configDigest)
      || typeof receipt.config !== 'string' || Buffer.byteLength(receipt.config)>2*1024*1024
      || 'sha256:'+createHash('sha256').update(receipt.config).digest('hex') !== receipt.configDigest) throw Error('Neo image configuration attestation changed');
    return receipt.configDigest;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(options.directory,{recursive:true,mode:0o700});
  const temporary = await mkdtemp(join(options.directory,'archive-')), archive = join(temporary,'image.tar');
  try {
    await run('docker',['image','save','--output',archive,artifact.reference],180_000);
    const manifest = JSON.parse(await run('tar',['-xOf',archive,'manifest.json'])) as {Config:string;RepoTags?:string[]}[];
    if (!Array.isArray(manifest) || manifest.length !== 1 || !manifest[0]?.RepoTags?.includes(artifact.reference)
      || !/^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/.test(manifest[0].Config)) throw Error('Neo image archive does not attest the registered image');
    const configPath = join(temporary,manifest[0].Config);
    await run('tar',['-xf',archive,'-C',temporary,manifest[0].Config]);
    const info=await lstat(configPath);
    if (!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024||await realpath(configPath)!==configPath
      ||await realpath(dirname(configPath))!==dirname(configPath)) throw Error('Bound Neo image configuration');
    const configBytes=await readFile(configPath),config=configBytes.toString('utf8');
    if (!Buffer.from(config,'utf8').equals(configBytes))throw Error('Expected an exact UTF-8 OCI config');
    const hash = createHash('sha256').update(configBytes).digest('hex');
    if (!manifest[0].Config.includes(hash) || await inspect() !== expected) throw Error('Neo image changed during configuration attestation');
    const configDigest = 'sha256:'+hash;
    await writeNeoDeliveryJson(cache,{artifactId:expected,configDigest,config});
    return configDigest;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
