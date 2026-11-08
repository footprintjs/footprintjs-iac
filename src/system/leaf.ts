import type { JsonObject } from '../types.ts';
import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { DeclarationScope } from './scope.ts';
import { scopeName } from './references.ts';
import { purposeValue } from './property-values.ts';
import type { Capability, CapabilityFamily, CapabilityKind } from './types.ts';

export class CapabilityBuilder extends DeclarationScope {
  protected properties: JsonObject = {};
  protected defaults: Record<string, string> = {};
  private id: string;
  private readonly path: string;
  private readonly family: CapabilityFamily;
  private readonly kind: CapabilityKind;
  constructor(group: string, leaf: string, family: CapabilityFamily, kind: CapabilityKind) {
    super();
    this.family = family; this.kind = kind;
    this.id = scopeName(leaf);
    this.path = `${scopeName(group)}.${this.id}`;
  }
  stableId(value: string): this { this.assertOpen(); this.id = identifier(value, 'stable capability id'); return this; }
  purpose(value: string): this { return this.set('purpose', purposeValue(value)); }
  protected set(key: string, value: unknown): this {
    this.assertOpen();
    this.properties[key] = jsonCopy(value);
    delete this.defaults[key];
    return this;
  }
  protected recipeDefault(key: string, value: unknown, reason: string): void {
    this.properties[key] = jsonCopy(value);
    this.defaults[key] = reason;
  }
  /** @internal Detached after the owning callback closes this builder. */
  snapshot(): Capability {
    return freeze({
      id: this.id, path: this.path, family: this.family, kind: this.kind,
      properties: jsonCopy(this.properties) as JsonObject,
      defaults: { ...this.defaults },
    });
  }
}
