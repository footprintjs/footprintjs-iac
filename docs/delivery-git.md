# Git and GitHub source adapters

The base delivery workflow accepts a `SourceAdapter`; repository hosting is independent of build recipes, artifact storage and deployment targets. The Node adapter is exported from `footprintjs-iac/delivery/git`.

```ts
import { createGitHubSourceAdapter } from 'footprintjs-iac/delivery/git';

const source = createGitHubSourceAdapter({
  directory: '/private/delivery/source-cache',
  repository: 'your-organization/your-application',
  allowedRefs: ['main', 'release/tested-version'],
});

// Supply this adapter at trusted host composition, alongside the build,
// artifact storage and deployment adapters. Browser requests select a
// configured delivery ID; they do not supply repository URLs or paths.
```

`GitSourceAdapter` accepts a configured credential-free HTTPS Git URL for other Git hosts. Explicitly enabled local repositories support offline hosts and contract tests. `createGitHubSourceAdapter` restricts repository syntax to GitHub and normalizes `owner/repository` to its HTTPS URL.

## Version selection and source acquisition

`resolve` checks the host-bound repository and revision catalog before any I/O, retrieves shallow Git objects into a private per-execution cache, and verifies the exact commit and tree. A durable source receipt pins that result. Repeating resolution for the same delivery execution reuses the pinned result even when the remote branch has advanced.

`fetch` materializes a detached real Git checkout from those verified objects. The checkout includes `.git` because some builders verify the index/tree and create their own source archive. Its origin, HEAD, index and clean working tree are checked before returning its host-controlled location. Changes are rejected without overwriting them. A new execution may select a newer branch commit.

The adapter does not run repository hooks or initialize submodules. Git LFS content and recursive submodule materialization are not implemented; consumers requiring them need an explicit source adapter. The supplied Neo consumer uses ordinary Git source and requires neither feature. Resolving a commit does not claim that rebuilding it is reproducible: recipes, dependencies, packaging identities and produced artifact digests must also be recorded.

## Authentication and recording

Authentication uses the local host's existing Git credential helper, with interactive Git prompts disabled. Credentials embedded in URLs, query strings and fragments are refused. Tokens are not part of delivery definitions or source receipts. Raw Git process failures are normalized before leaving the default runner. The optional command runner is a trusted host injection point, not a browser feature.

The source checkout and private cache remain local to the executing machine. Public native delivery evidence contains the admitted source revision and stage outcomes; the generic delivery workflow keeps host locations and opaque adapter metadata in its private ledger. Builds and deployments are separate effectful stages, rather than side effects of graph construction or capability compilation.

The adapter does not install webhooks, dispatch GitHub Actions, push commits, publish images or deploy infrastructure. Manual Lens/CLI execution uses the same source adapter while automatic CI remains off.
