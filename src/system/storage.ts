import { CapabilityBuilder } from './leaf.ts';
import { DeclarationScope, invokeScope } from './scope.ts';
import { choice, durationFields, replicationValue, retentionValue } from './property-values.ts';
import type { Capability, DataModel, Durability, Expiration, Replication, Retention, Sharing } from './types.ts';

export class StoreBuilder extends CapabilityBuilder {
  constructor(group: string, leaf: string, recipe: 'generic' | 'session' | 'data' = 'generic') {
    super(group, leaf, 'storage', 'store');
    if (recipe !== 'generic') {
      this.recipeDefault('purpose', recipe === 'session' ? 'session' : 'data', `add${recipe === 'session' ? 'Session' : 'Data'}Store recipe`);
      this.recipeDefault('dataModel', recipe === 'session' ? 'keyValue' : 'relational', `add${recipe === 'session' ? 'Session' : 'Data'}Store recipe`);
    }
  }
  dataModel(value: DataModel): this { return this.set('dataModel', choice(value, ['keyValue', 'relational', 'document', 'object', 'file', 'block'], 'data model')); }
  sharing(value: Sharing): this { return this.set('sharing', choice(value, ['local', 'shared'], 'sharing')); }
  durability(value: Durability): this { return this.set('durability', choice(value, ['ephemeral', 'persistent'], 'durability')); }
  expiration(value: Expiration): this { return this.set('expiration', durationFields(value, ['idle', 'absolute'], 'expiration')); }
  retention(value: Retention): this { return this.set('retention', retentionValue(value)); }
  replication(value: Replication): this { return this.set('replication', replicationValue(value)); }
  retainOnRemoval(value = true): this {
    if (typeof value !== 'boolean') throw new Error('retainOnRemoval requires a boolean');
    return this.retention({ ...(this.properties.retention as Retention | undefined), onRemoval: value ? 'retain' : 'delete' });
  }
}
export class StorageScope extends DeclarationScope {
  private readonly capabilities: Capability[] = [];
  private readonly group: string;
  constructor(group: string) { super(); this.group = group; }
  addStore(id: string, callback: (store: StoreBuilder) => StoreBuilder | void): this { return this.add(id, callback, 'generic'); }
  addSessionStore(id: string, callback: (store: StoreBuilder) => StoreBuilder | void): this { return this.add(id, callback, 'session'); }
  addDataStore(id: string, callback: (store: StoreBuilder) => StoreBuilder | void): this { return this.add(id, callback, 'data'); }
  private add(id: string, callback: (store: StoreBuilder) => StoreBuilder | void, recipe: 'generic' | 'session' | 'data'): this {
    this.assertOpen();
    const store = new StoreBuilder(this.group, id, recipe);
    invokeScope(store, callback);
    this.capabilities.push(store.snapshot());
    return this;
  }
  /** @internal */ snapshot(): Capability[] { return [...this.capabilities]; }
}
