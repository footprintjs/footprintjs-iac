export interface ReviewedSourceRevision {
  readonly baseCommit: string;
  readonly committedTree: string;
  readonly sourceTree: string;
}

/** Classify an already-admitted immutable source tree, independently of checks or publication. */
export function describeSourceReview(revision: ReviewedSourceRevision) {
  for (const value of [revision.baseCommit, revision.committedTree, revision.sourceTree]) {
    if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Source review requires exact Git revisions');
  }
  return {
    baseCommit: revision.baseCommit,
    sourceTree: revision.sourceTree,
    sourceStatus: revision.committedTree === revision.sourceTree
      ? 'committed-clean' as const : 'reviewed-uncommitted-index' as const,
    fullAppCheckStatus: 'not-assessed-by-build' as const,
    publicationStatus: 'not-assessed-by-build' as const,
  };
}
