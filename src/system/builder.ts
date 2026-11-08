import type { JsonObject } from '../types.ts';
import type { Boundary } from '../graph/types.ts';
import { readBoundary } from '../graph/boundaries.ts';
import { freeze, identifier, jsonCopy, object } from '../graph/data.ts';
import { ComputeScope } from './compute.ts';
import { NetworkScope } from './network.ts';
import { StorageScope } from './storage.ts';
import { DeclarationScope, invokeScope } from './scope.ts';
import { compileSystem } from './compile.ts';
import type { PendingMembership, PendingRelation } from './compile.ts';
import { readReference, scopeName } from './references.ts';
import type { Capability, CapabilityReference, CapabilityRelation, Principal, SystemDesign } from './types.ts';

export type SystemRecipe = (system: SystemBuilder) => SystemBuilder | void;
export class SystemBuilder extends DeclarationScope {
  private readonly name: string;
  private capabilities: Capability[] = [];
  private principals: Principal[] = [];
  private boundaries: Boundary[] = [];
  private memberships: PendingMembership[] = [];
  private relations: PendingRelation[] = [];
  private groups = new Set<string>();
  private busy = false;
  private recipeDraft = false;
  private built: SystemDesign | undefined;
  constructor(name: string) { super(); this.name = identifier(name, 'system name'); }

  addCompute(name: string, callback: (compute: ComputeScope) => ComputeScope | void): this {
    return this.addGroup(name, new ComputeScope(name), callback);
  }
  addStorage(name: string, callback: (storage: StorageScope) => StorageScope | void): this {
    return this.addGroup(name, new StorageScope(name), callback);
  }
  addNetwork(name: string, callback: (network: NetworkScope) => NetworkScope | void): this {
    return this.addGroup(name, new NetworkScope(name), callback);
  }
  principal(id: string, properties: JsonObject = {}): this {
    this.assertMutable();
    identifier(id, 'principal id');
    if (this.principals.some(principal => principal.id === id)) throw new Error('Duplicate principal id');
    this.principals.push(freeze({ id, path: id, properties: object(jsonCopy(properties), 'principal properties') }));
    return this;
  }
  boundary(definition: Boundary): this {
    this.assertMutable();
    const boundary = readBoundary(jsonCopy(definition));
    if (this.boundaries.some(row => row.id === boundary.id)) throw new Error('Duplicate boundary id');
    this.boundaries.push(freeze(boundary));
    return this;
  }
  within(boundaryId: string, ...references: CapabilityReference[]): this {
    this.assertMutable();
    identifier(boundaryId, 'boundary id');
    if (!references.length) throw new Error('within requires at least one capability reference');
    for (const value of references) {
      const reference = this.capabilityRef(value);
      if (this.memberships.some(row => row.boundaryId === boundaryId && row.reference.path === reference.path)) throw new Error('Duplicate capability membership');
      this.memberships.push({ boundaryId, reference });
    }
    return this;
  }
  connect(from: CapabilityReference, to: CapabilityReference, kind: CapabilityRelation['kind'], label?: string): this {
    this.assertMutable();
    if (kind !== 'dependsOn' && kind !== 'communicatesWith') throw new Error('Invalid capability relation kind');
    const relation: PendingRelation = {
      from: this.capabilityRef(from), to: this.capabilityRef(to), kind,
      ...(label === undefined ? {} : { label }),
    };
    if (this.relations.some(row => row.from.path === relation.from.path && row.to.path === relation.to.path && row.kind === kind)) throw new Error('Duplicate capability relation');
    this.relations.push(relation);
    return this;
  }
  dependsOn(target: CapabilityReference, ...sources: CapabilityReference[]): this {
    if (!sources.length) throw new Error('dependsOn requires at least one source');
    for (const source of sources) this.connect(source, target, 'dependsOn');
    return this;
  }
  /** Expand a domain recipe on an isolated, closable draft; it adds no second execution engine. */
  use(recipe: SystemRecipe): this {
    this.assertMutable();
    const draft = new SystemBuilder(this.name);
    draft.capabilities = [...this.capabilities]; draft.principals = [...this.principals];
    draft.boundaries = [...this.boundaries]; draft.memberships = [...this.memberships];
    draft.relations = [...this.relations]; draft.groups = new Set(this.groups);
    draft.recipeDraft = true;
    this.busy = true;
    try {
      invokeScope(draft, recipe);
      this.capabilities = draft.capabilities; this.principals = draft.principals;
      this.boundaries = draft.boundaries; this.memberships = draft.memberships;
      this.relations = draft.relations; this.groups = draft.groups;
    } finally { this.busy = false; }
    return this;
  }
  build(): SystemDesign {
    if (this.built) return this.built;
    this.assertMutable();
    if (this.recipeDraft) throw new Error('A recipe expands its owner; it cannot build a separate system');
    const design = compileSystem({
      name: this.name, capabilities: this.capabilities, principals: this.principals,
      boundaries: this.boundaries, memberships: this.memberships, relations: this.relations,
    });
    this.built = design;
    this.close();
    return design;
  }
  private assertMutable(): void {
    this.assertOpen();
    if (this.busy) throw new Error('Use the provided scoped builder inside a callback');
  }
  private capabilityRef(input: CapabilityReference): CapabilityReference {
    const reference = readReference(input);
    if (reference.kind === 'principal') throw new Error('Principal references are not capability references');
    return freeze(reference as CapabilityReference);
  }
  private addGroup<T extends DeclarationScope & { snapshot(): Capability[] }>(name: string, scope: T, callback: (scope: T) => T | void): this {
    this.assertMutable();
    scopeName(name);
    if (this.groups.has(name)) throw new Error('Duplicate capability group');
    this.busy = true;
    try {
      invokeScope(scope, callback);
      const rows = scope.snapshot();
      if (!rows.length) throw new Error('Capability groups require at least one child declaration');
      this.capabilities.push(...rows);
      this.groups.add(name);
    } finally { this.busy = false; }
    return this;
  }
}
export function system(name: string): SystemBuilder { return new SystemBuilder(name); }
