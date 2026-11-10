import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { command } from './command.ts';
import { assertSealedIdentityFiles } from './sealed-files.ts';
import { assertIdentityCluster, identityApiPort, validateIdentityTarget } from './validate-target.ts';
import { identityRoot } from './paths.ts';
export { assertIdentityCluster, identityApiPort, validateIdentityTarget } from './validate-target.ts';
export { identityRoot } from './paths.ts';

export interface IdentityTarget {
  version: 1; id: string; directory: string;
  context: string; kubeconfig: string; namespace: string;
  stateDirectory: string; sourceDirectory?: string; sourceCommit?: string;
  neoPort: number; providerPort: number; ldapPort: number;
  issuer: string; providerName: string; directoryName: string;
  fixtureDigest: string; providerAddress?: string;
  images: { nodeImage: string; pythonImage: string; ldapImage: string; providerImage: string };
}
/** root and runner are trusted test seams; an HTTP request cannot supply either. */
export async function loadIdentityTarget(path?: string, options: { root?: string; runner?: typeof command } = {}): Promise<IdentityTarget> {
  try {
    const root = resolve(options.root ?? identityRoot), selected = resolve(path ?? resolve(root, 'latest.json'));
    const target = validateIdentityTarget(JSON.parse(await readFile(selected, 'utf8')), root);
    if (![resolve(root, 'latest.json'), resolve(target.directory, 'target.json')].includes(selected)) throw Error();
    for (const location of [root, target.directory, selected, target.kubeconfig]) {
      if (await realpath(location) !== location || (await lstat(location)).isSymbolicLink()) throw Error();
    }
    let stateInfo;
    try { stateInfo = await lstat(target.stateDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (stateInfo && (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || await realpath(target.stateDirectory) !== target.stateDirectory)) throw Error();
    const configInfo = await lstat(target.kubeconfig);
    if (!configInfo.isFile() || configInfo.size > 1024 * 1024 || (configInfo.mode & 0o077) !== 0) throw Error();
    const preparedPath = resolve(target.kubeconfig, '../prepared.json');
    if (await realpath(preparedPath) !== preparedPath) throw Error();
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as { version: number; stage: string; context: string; clusterName: string; kubeconfig: string };
    if (prepared.version !== 1 || prepared.stage !== 'prepared' || prepared.context !== target.context
      || prepared.clusterName !== target.context.slice(5) || prepared.kubeconfig !== target.kubeconfig) throw Error();
    await assertSealedIdentityFiles(target.directory, target.fixtureDigest);
    const port = identityApiPort(parse(await readFile(target.kubeconfig, 'utf8'), { maxAliasCount: 0 }), target.context);
    const observed = JSON.parse(await (options.runner ?? command)('docker', ['inspect', target.context.slice(5) + '-control-plane']));
    assertIdentityCluster(observed, target.context, port);
    return target;
  } catch { throw new Error('Identity target admission failed'); }
}
