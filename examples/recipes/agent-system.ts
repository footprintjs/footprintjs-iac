import { ref, type ArtifactReference, type SystemRecipe } from '../../src/system/index.ts';

/** An illustrative domain wrapper. It composes the public base and adds no separate compiler or engine. */
export function agentSystemRecipe(options: { program: ArtifactReference; prefix?: string; retainHistory?: boolean }): SystemRecipe {
  const prefix = options.prefix ?? 'agent';
  return design => design
    .addNetwork(`${prefix}-network`, network => network.addSegment(`${prefix}-backend`))
    .addStorage(`${prefix}-state`, storage => storage
      .addSessionStore(`${prefix}-sessions`, sessions => sessions
        .sharing('shared').durability('persistent').expiration({ idle: '30m' }))
      .addDataStore(`${prefix}-history`, history => history
        .durability('persistent').retainOnRemoval(options.retainHistory ?? true)))
    .addCompute(`${prefix}-application`, compute => compute.addService(`${prefix}-agent`, service => service
      .program(options.program)
      .useNetwork(ref.network(`${prefix}-network.${prefix}-backend`))
      .useStorage(ref.store(`${prefix}-state.${prefix}-sessions`), { access: 'readWrite' })
      .useStorage(ref.store(`${prefix}-state.${prefix}-history`), { access: 'readWrite' })));
}
