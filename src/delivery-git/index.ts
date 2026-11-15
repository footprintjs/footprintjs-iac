export { GitSourceAdapter, type GitSourceOptions } from './adapter.ts';
export type { GitRunner } from './command.ts';
export { githubRepository } from './input.ts';
import { GitSourceAdapter, type GitSourceOptions } from './adapter.ts';
import { githubRepository } from './input.ts';

/** GitHub is a repository adapter; build and runtime choices remain independently injected. */
export function createGitHubSourceAdapter(options: Omit<GitSourceOptions, 'allowLocalRepository'>): GitSourceAdapter {
  return new GitSourceAdapter({ ...options, repository: githubRepository(options.repository), allowLocalRepository: false });
}
