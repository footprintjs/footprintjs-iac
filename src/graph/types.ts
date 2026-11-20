import type { Json, JsonObject, Resource, Stack } from '../types.ts';

export type BoundaryKind = 'region' | 'security' | 'role' | 'physical' | 'ownership' | 'group';
export interface BoundaryRequirement {
  kind: string;
  mode: 'required' | 'advisory';
  value?: Json;
}
export interface Boundary {
  id: string;
  kind: BoundaryKind;
  label?: string;
  parent?: string;
  attributes?: JsonObject;
  requirements?: BoundaryRequirement[];
}
export interface Membership { resourceId: string; boundaryId: string }
export type RelationKind = 'order' | 'data' | 'communicatesWith' | 'runsOn' | 'assumesRole';
export interface Relation { details?: import('./communication.ts').CommunicationDetails; from: string; to: string; kind: RelationKind; label?: string }

/** Role boundaries describe architecture; they grant no IAM permissions. */
export interface InfraGraph extends Stack {
  kind: 'infra-graph';
  version: 1;
  boundaries: Boundary[];
  memberships: Membership[];
  relations: Relation[];
  digest: string;
}
export type GraphBody = Omit<InfraGraph, 'digest'>;
export type ResourceRef = Resource | string;
export interface SegmentGroup {
  kind: 'serial-group' | 'parallel-group';
  segments: readonly Segment[];
}
export type Segment = ResourceRef | SegmentGroup;
