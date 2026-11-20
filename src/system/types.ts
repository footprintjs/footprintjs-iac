import type { CommunicationDetails } from '../graph/communication.ts';
import type { JsonObject } from '../types.ts';
import type { Boundary } from '../graph/types.ts';

export type CapabilityFamily = 'compute' | 'storage' | 'network';
export type CapabilityKind = 'service' | 'job' | 'scheduled-task' | 'store' | 'segment' | 'endpoint';
export type ReferenceKind = 'store' | 'network' | 'service' | 'principal';
export interface Reference<K extends ReferenceKind = ReferenceKind> { kind: K; path: string }
export type StoreReference = Reference<'store'>;
export type NetworkReference = Reference<'network'>;
export type ServiceReference = Reference<'service'>;
export type PrincipalReference = Reference<'principal'>;
export type CapabilityReference = StoreReference | NetworkReference | ServiceReference;
export interface ArtifactReference { kind: 'artifact'; id: string }
export type StorageAccess = 'read' | 'write' | 'readWrite';
export type DataModel = 'keyValue' | 'relational' | 'document' | 'object' | 'file' | 'block';
export type Sharing = 'local' | 'shared';
export type Durability = 'ephemeral' | 'persistent';
export interface Expiration { idle?: string; absolute?: string }
export interface Retention { onRemoval?: 'retain' | 'delete'; period?: string }
export interface Replication { copies: number }
export interface Capability {
  id: string;
  path: string;
  family: CapabilityFamily;
  kind: CapabilityKind;
  properties: JsonObject;
  /** Property defaults still in effect, with their recipe reasons. Explicit choices remove entries. */
  defaults: Record<string, string>;
}
export interface Principal { id: string; path: string; properties: JsonObject }
export interface CapabilityMembership { capabilityId: string; boundaryId: string }
export interface CapabilityRelation {
  details?: CommunicationDetails;
  from: string;
  to: string;
  kind: 'dependsOn' | 'communicatesWith';
  label?: string;
}
export interface SystemDesign {
  kind: 'system-design';
  version: 1;
  name: string;
  capabilities: Capability[];
  boundaries: Boundary[];
  memberships: CapabilityMembership[];
  relations: CapabilityRelation[];
  principals: Principal[];
  digest: string;
}
export type SystemBody = Omit<SystemDesign, 'digest'>;
