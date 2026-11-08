import type { Json, JsonObject, Resource } from '../types.ts';
import type { InfraGraph, Relation } from '../graph/types.ts';
import type { Capability, Principal } from '../system/types.ts';

export interface BindingTarget { id: string; properties?: JsonObject }
export interface BindingRule {
  id: string;
  family: Capability['family'];
  kind?: Capability['kind'];
  properties?: JsonObject;
  adapterId: string;
}
export type RequirementStatus = 'simulated' | 'implemented';
/** An adapter's declaration, never an observed verification result. */
export interface RequirementSupport {
  property: string;
  requested: Json;
  status: RequirementStatus;
  reason: string;
}
export interface SupportAssessment {
  supported: boolean;
  reason: string;
  unsupportedRequirements: string[];
  requirements: RequirementSupport[];
}
export interface SupportContext {
  readonly profileId: string;
  readonly target: BindingTarget;
  artifact(reference: unknown): JsonObject;
  principal(reference: unknown): Principal;
}
export interface LoweringContext extends SupportContext {
  /** Every returned resource must use an ID allocated here, binding identity to this target. */
  resourceId(suffix?: string): string;
  mapping(reference: unknown): CapabilityMapping;
}
export interface LoweredCapability {
  resources: Resource[];
  internalRelations?: Relation[];
}
/** Trusted synchronous compiler extension. No SDK, I/O, observation or mutation belongs here. */
export interface CapabilityAdapter {
  id: string;
  mode: 'simulation' | 'real';
  supports(capability: Capability, context: SupportContext): SupportAssessment;
  lower(capability: Capability, context: LoweringContext): LoweredCapability;
}
export interface BindingProfile {
  id: string;
  target: BindingTarget;
  rules: BindingRule[];
  adapters: CapabilityAdapter[];
  artifacts: Record<string, JsonObject>;
}
export interface SelectionCandidate { ruleId: string; matched: boolean; reason: string }
export interface BindingDecision {
  capabilityId: string;
  capabilityPath: string;
  adapterId: string;
  ruleId: string;
  targetId: string;
  mode: CapabilityAdapter['mode'];
  status: RequirementStatus;
  reason: string;
  requirements: RequirementSupport[];
  defaults: Record<string, string>;
  candidates: SelectionCandidate[];
}
export interface CapabilityMapping {
  capabilityId: string;
  capabilityPath: string;
  adapterId: string;
  targetId: string;
  mode: CapabilityAdapter['mode'];
  resourceIds: string[];
  entryPoints: string[];
  exitPoints: string[];
  groupId: string;
}
export interface BindingResult {
  readonly kind: 'system-binding';
  readonly version: 1;
  readonly profileId: string;
  readonly targetId: string;
  readonly target: BindingTarget;
  readonly designDigest: string;
  readonly graph: InfraGraph;
  readonly decisions: BindingDecision[];
  readonly mappings: CapabilityMapping[];
  readonly digest: string;
}
