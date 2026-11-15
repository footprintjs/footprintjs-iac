import { resolve } from 'node:path';
import type { DeliveryContext, DeliverySource, SourceAdapter, SourceRevision, SourceSnapshot } from '../delivery/types.ts';
import { fingerprint } from '../util.ts';
import { runGit, type GitRunner } from './command.ts';
import { exists, gitWorkspace, readGitReceipt, saveGitReceipt } from './files.ts';
import { gitRef, gitRepository, readGitRevision } from './input.ts';

export interface GitSourceOptions {
  directory: string; repository: string; allowedRefs: readonly string[];
  /** Trusted local Git repositories are useful for offline hosts and isolated contract tests. */
  allowLocalRepository?: boolean;
  /** Trusted host seam, never accepted from a browser or a delivery definition. */
  runner?: GitRunner;
}
/** Repository acquisition is separate from builds and infrastructure. No repository hooks are run. */
export class GitSourceAdapter implements SourceAdapter {
  readonly repository: string;
  private readonly directory: string;
  private readonly refs: ReadonlySet<string>;
  private readonly runner: GitRunner;
  constructor(options: GitSourceOptions) {
    this.repository = gitRepository(options.repository, options.allowLocalRepository === true);
    if (!Array.isArray(options.allowedRefs) || !options.allowedRefs.length || options.allowedRefs.length > 64) throw Error('Configure a bounded Git revision catalog');
    this.refs = new Set(options.allowedRefs.map(gitRef));
    this.directory = resolve(options.directory); this.runner = options.runner ?? runGit;
  }
  private source(input: DeliverySource): DeliverySource {
    if (!input || input.repository !== this.repository || !this.refs.has(gitRef(input.ref))) throw Error('Source is outside the configured repository and revision catalog');
    return { repository: this.repository, ref: input.ref };
  }
  private git(args: string[], cwd?: string): Promise<string> { return this.runner(args, { ...(cwd ? { cwd } : {}) }); }
  async resolve(input: DeliverySource, context: DeliveryContext): Promise<SourceRevision> {
    const source = this.source(input), workspace = await gitWorkspace(this.directory, context);
    const binding = fingerprint({ source, target: context.target, definitionDigest: context.definitionDigest });
    const stored = await readGitReceipt(workspace.receipt) as { binding?: string; revision?: SourceRevision } | undefined;
    if (stored) {
      if (stored.binding !== binding || !stored.revision) throw Error('Source receipt belongs to another delivery');
      const revision = readGitRevision(stored.revision, source);
      await this.verify(workspace.repository, revision);
      return revision;
    }
    if (!(await exists(workspace.repository))) {
      await this.git(['init', '--bare', workspace.repository]);
      await this.git(['remote', 'add', 'origin', this.repository], workspace.repository);
    }
    if (await this.git(['remote', 'get-url', 'origin'], workspace.repository) !== this.repository) throw Error('Git source origin changed');
    await this.git(['fetch', '--no-tags', '--depth=1', '--', 'origin', source.ref], workspace.repository);
    const commit = await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], workspace.repository);
    const tree = await this.git(['rev-parse', '--verify', commit + '^{tree}'], workspace.repository);
    const revision = readGitRevision({ ...source, commit, tree }, source);
    if (/^[a-f0-9]{40}$/.test(source.ref) && revision.commit !== source.ref) throw Error('Git returned a different pinned commit');
    await this.git(['update-ref', 'refs/heads/delivery-pinned', commit], workspace.repository);
    await this.git(['symbolic-ref', 'HEAD', 'refs/heads/delivery-pinned'], workspace.repository);
    await saveGitReceipt(workspace.receipt, { binding, revision });
    return revision;
  }
  async fetch(input: SourceRevision, context: DeliveryContext): Promise<SourceSnapshot> {
    const source = this.source(input), revision = readGitRevision(input, source), workspace = await gitWorkspace(this.directory, context);
    const receipt = await readGitReceipt(workspace.receipt) as { binding?: string; revision?: SourceRevision } | undefined;
    if (receipt?.binding !== fingerprint({ source, target: context.target, definitionDigest: context.definitionDigest })
      || fingerprint(receipt.revision) !== fingerprint(revision)) throw Error('Resolve this exact Git revision before fetching source');
    await this.verify(workspace.repository, revision);
    if (!(await exists(workspace.checkout))) {
      await this.git(['clone', '--no-checkout', '--no-hardlinks', '--', workspace.repository, workspace.checkout]);
      await this.git(['remote', 'set-url', 'origin', this.repository], workspace.checkout);
      await this.git(['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false',
        'checkout', '--detach', revision.commit], workspace.checkout);
    }
    if (await this.git(['remote', 'get-url', 'origin'], workspace.checkout) !== this.repository
      || await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], workspace.checkout) !== revision.commit
      || await this.git(['write-tree'], workspace.checkout) !== revision.tree
      || (await this.git(['ls-files', '-v', '-z'], workspace.checkout)).split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))
      || await this.git(['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], workspace.checkout)) throw Error('The fetched Git snapshot was changed; it cannot be reused');
    return { revision, location: workspace.checkout };
  }
  private async verify(directory: string, revision: SourceRevision): Promise<void> {
    if (!(await exists(directory)) || await this.git(['remote', 'get-url', 'origin'], directory) !== this.repository
      || await this.git(['rev-parse', '--verify', 'refs/heads/delivery-pinned^{commit}'], directory) !== revision.commit
      || await this.git(['rev-parse', '--verify', revision.commit + '^{tree}'], directory) !== revision.tree) throw Error('The pinned Git source objects changed');
  }
}
