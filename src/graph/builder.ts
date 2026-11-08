import type { JsonObject, Resource } from '../types.ts';
import { canonical } from '../util.ts';
import { readBoundary } from './boundaries.ts';
import { relationKey } from './artifact.ts';
import { compileGraph } from './compile.ts';
import { freeze, identifier, jsonCopy } from './data.ts';
import { readResource } from './resources.ts';
import { copySegment, parallelGroup, serialGroup } from './segments.ts';
import type { Boundary, InfraGraph, Membership, Relation, RelationKind, ResourceRef, Segment } from './types.ts';

interface Ends { entries: string[]; exits: string[] }

/** A declaration builder. No provider observations or mutations happen before plan/apply. */
export class InfraBuilder {
  private readonly name: string;
  private readonly resources = new Map<string, Resource>();
  private readonly boundaries = new Map<string, Boundary>();
  private readonly memberships: Membership[] = [];
  private readonly relations: Relation[] = [];
  private frontier: string[] = [];

  constructor(name: string) { this.name = identifier(name, 'stack name'); }

  resource(value: Resource): this;
  resource(id: string, provider: string, spec: JsonObject, dependsOn?: string[]): this;
  resource(value: Resource | string, provider?: string, spec?: JsonObject, dependsOn?: string[]): this {
    const row = readResource(typeof value === 'string'
      ? { id: value, provider, spec, ...(dependsOn === undefined ? {} : { dependsOn }) } : value);
    if (this.resources.has(row.id)) throw new Error(`Duplicate resource declaration: ${row.id}`);
    this.resources.set(row.id, freeze(row));
    return this;
  }
  boundary(value: Boundary): this {
    const row = readBoundary(jsonCopy(value));
    if (this.boundaries.has(row.id)) throw new Error(`Duplicate boundary: ${row.id}`);
    this.boundaries.set(row.id, freeze(row));
    return this;
  }
  within(boundary: string, ...resources: ResourceRef[]): this {
    const boundaryId = identifier(boundary, 'boundary reference');
    if (resources.length === 0) throw new Error('within requires at least one resource');
    for (const resource of resources) {
      const resourceId = this.reference(resource);
      if (this.memberships.some(row => row.boundaryId === boundaryId && row.resourceId === resourceId)) {
        throw new Error(`Duplicate boundary membership: ${resourceId}/${boundaryId}`);
      }
      this.memberships.push({ resourceId, boundaryId });
    }
    return this;
  }
  connect(from: ResourceRef, to: ResourceRef, kind: RelationKind, label?: string): this {
    const relation: Relation = {
      from: this.reference(from), to: this.reference(to), kind,
      ...(label === undefined ? {} : { label }),
    };
    if (this.relations.some(row => relationKey(row) === relationKey(relation))) throw new Error('Duplicate relation');
    this.relations.push(relation);
    return this;
  }
  dependsOn(target: ResourceRef, ...sources: ResourceRef[]): this {
    if (sources.length === 0) throw new Error('dependsOn requires at least one source');
    const to = this.reference(target);
    for (const source of sources) this.order(this.reference(source), to);
    return this;
  }

  /** Start an independent chain; existing declarations/edges remain in the graph. */
  start(segment: Segment): this {
    this.frontier = this.expand(copySegment(segment)).exits;
    return this;
  }
  /** Append a serial sequence; all prior frontier nodes precede its entries. */
  next(...segments: Segment[]): this { return this.append(serialGroup(...segments)); }
  serial(...segments: Segment[]): this { return this.next(...segments); }
  /** Fork from the current frontier; the next append joins every branch exit. */
  parallel(...segments: Segment[]): this { return this.append(parallelGroup(...segments)); }

  synth(): InfraGraph {
    return compileGraph({
      name: this.name, resources: [...this.resources.values()], boundaries: [...this.boundaries.values()],
      memberships: this.memberships, relations: this.relations,
    });
  }
  build(): InfraGraph { return this.synth(); }

  private append(segment: Segment): this {
    const ends = this.expand(segment);
    for (const from of this.frontier) for (const to of ends.entries) this.order(from, to);
    this.frontier = ends.exits;
    return this;
  }
  private reference(value: ResourceRef): string {
    if (typeof value === 'string') return identifier(value, 'resource reference');
    const row = readResource(value);
    const old = this.resources.get(row.id);
    if (old && canonical(old) !== canonical(row)) throw new Error(`Conflicting resource definition: ${row.id}`);
    if (!old) this.resources.set(row.id, freeze(row));
    return row.id;
  }
  private order(from: string, to: string): void {
    const row: Relation = { from, to, kind: 'order' };
    if (!this.relations.some(relation => relationKey(relation) === relationKey(row))) this.relations.push(row);
  }
  private expand(segment: Segment): Ends {
    if (typeof segment === 'string' || !('kind' in segment)) {
      const id = this.reference(segment);
      return { entries: [id], exits: [id] };
    }
    const branches = segment.segments.map(child => this.expand(child));
    if (segment.kind === 'parallel-group') {
      return { entries: [...new Set(branches.flatMap(branch => branch.entries))], exits: [...new Set(branches.flatMap(branch => branch.exits))] };
    }
    for (let index = 1; index < branches.length; index++) {
      for (const from of branches[index - 1]!.exits) for (const to of branches[index]!.entries) this.order(from, to);
    }
    return { entries: branches[0]!.entries, exits: branches[branches.length - 1]!.exits };
  }
}
export function infra(name: string): InfraBuilder { return new InfraBuilder(name); }
