import type { Resource, ResourceAdapter } from './types.ts';
import { canonical } from './util.ts';

export class ProviderChangeError extends Error {
  readonly disposition: 'replace' | 'reject';
  readonly resourceId: string;
  readonly provider: string;
  constructor(resource: Resource, disposition: 'replace' | 'reject', reason: string) {
    super(`${resource.provider} ${disposition} required for ${resource.id}: ${reason}`);
    this.name = 'ProviderChangeError';
    this.disposition = disposition;
    this.resourceId = resource.id;
    this.provider = resource.provider;
  }
}

/** The engine never executes replacement on the strength of a classification alone. */
export function assertProviderChange(adapter: ResourceAdapter | undefined, previous: Resource, desired: Resource): void {
  if (!adapter?.assessChange || canonical(previous.spec) === canonical(desired.spec)) return;
  const assessment = adapter.assessChange(structuredClone(previous), structuredClone(desired));
  if (!assessment || !['update', 'replace', 'reject'].includes(assessment.disposition)
    || (assessment.disposition !== 'update' && (typeof assessment.reason !== 'string' || !assessment.reason.trim() || assessment.reason.length > 4096))) {
    throw Error(`Invalid change assessment for ${desired.id}`);
  }
  if (assessment.disposition !== 'update') throw new ProviderChangeError(desired, assessment.disposition, assessment.reason);
}
