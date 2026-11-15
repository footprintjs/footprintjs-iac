import { identifier } from '../graph/data.ts';
import { readConnectionProfileChoices } from './data.ts';
import type { ConnectionProfileChoice } from './types.ts';

/** Dynamic catalogs must return immutable profile IDs: revisions receive a new ID. */
export type ResourceFlowProfiles = readonly ConnectionProfileChoice[] | (() => Promise<readonly ConnectionProfileChoice[]>);

export class ResourceFlowProfileCatalog {
  readonly identity: { profiles: ConnectionProfileChoice[] } | { profileCatalogId: string };
  readonly dynamic: boolean;
  private readonly source: ResourceFlowProfiles;
  constructor(source: ResourceFlowProfiles, catalogId?: string) {
    this.dynamic = typeof source === 'function';
    if (typeof source === 'function') {
      this.identity = { profileCatalogId: identifier(catalogId, 'connection profile catalog') };
      this.source = source;
    } else {
      const profiles = readConnectionProfileChoices(source);
      this.identity = { profiles }; this.source = profiles;
    }
  }
  async list(): Promise<ConnectionProfileChoice[]> {
    return readConnectionProfileChoices(typeof this.source === 'function' ? await this.source() : this.source, { allowEmpty: this.dynamic });
  }
}
