import { publicSourceRepository } from './source-identity.ts';
import type { DeliveryDefinition, DeliveryResults, SourceRevision } from './types.ts';

/** A source identity is public; a host filesystem path is not. No I/O is performed. */
const recordedRepository=publicSourceRepository;
function recordedRevision(revision: SourceRevision): SourceRevision {
  return { ...revision, repository: recordedRepository(revision.repository) };
}
export function recordedDeliveryDefinition(definition: DeliveryDefinition): DeliveryDefinition {
  return { ...definition, source: { ...definition.source, repository: recordedRepository(definition.source.repository) } };
}

/** Only these value-free host-handle summaries cross the native-recording/browser boundary. */
export function recordedDeliveryResult<K extends keyof DeliveryResults>(key: K, results: DeliveryResults): unknown {
  switch (key) {
    case 'revision': return results.revision && recordedRevision(results.revision);
    case 'source': return results.source && { revision: recordedRevision(results.source.revision), available: true };
    case 'build': return results.build && { artifacts: results.build.artifacts, recipeDigest: results.build.recipeDigest };
    case 'publication': return results.publication && { artifacts: results.publication.artifacts };
    case 'plan': return results.plan && { id: results.plan.id, digest: results.plan.digest, changes: results.plan.changes,...(results.plan.evidence?{evidence:results.plan.evidence}:{}) };
    case 'deployment': return results.deployment && { ok: results.deployment.ok, ...(results.deployment.runId ? { runId: results.deployment.runId } : {}),...(results.deployment.evidence?{evidence:results.deployment.evidence}:{}) };
    case 'verification': return results.verification && { ok: results.verification.ok, checks: results.verification.checks };
  }
}
