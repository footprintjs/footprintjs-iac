import { freeze } from '../graph/data.ts';
import { readSystemDesign } from '../system/validation.ts';
import { designHandles, registerDesignHandles } from '../system/handles.ts';
import { fingerprint } from '../util.ts';
import type { SystemDesign } from '../system/types.ts';
import { readProfile } from './profile.ts';
import { selectAdapter } from './selection.ts';
import { supportContext, loweringContext } from './context.ts';
import { synchronousResult } from './data.ts';
import { readSupport } from './support.ts';
import { validateLowering, type ExpandedCapability } from './lowering.ts';
import { expandGraph } from './expansion.ts';
import { orderCapabilities } from './order.ts';
import type { BindingDecision, BindingProfile, BindingResult, CapabilityMapping } from './types.ts';

/** Pure synchronous compilation. Adapter callbacks are trusted compiler extensions, not a security sandbox. */
export function bindSystem(input: SystemDesign, inputProfile: BindingProfile): BindingResult {
  const design = readSystemDesign(input);
  const profile = readProfile(inputProfile);
  for (const boundary of design.boundaries) {
    const required = boundary.requirements?.find(requirement => requirement.mode === 'required');
    if (required) throw new Error('Unsupported required boundary enforcement: ' + boundary.id + '/' + required.kind);
  }
  const baseContext = supportContext(design, profile);
  const selections = new Map(design.capabilities.map(capability => [capability.id, selectAdapter(capability, profile)]));
  const decisions: BindingDecision[] = [];
  // Admit all requirements before any lowering. Failure cannot leave a partial bound graph.
  for (const capability of design.capabilities) {
    const selection = selections.get(capability.id)!;
    const assessment = readSupport(synchronousResult(selection.adapter.supports(capability, baseContext), 'adapter supports'), capability, selection.adapter);
    decisions.push({
      capabilityId: capability.id, capabilityPath: capability.path, adapterId: selection.adapter.id,
      ruleId: selection.rule.id, targetId: profile.target.id, mode: selection.adapter.mode,
      status: selection.adapter.mode === 'simulation' ? 'simulated' : 'implemented',
      reason: assessment.reason, requirements: assessment.requirements, defaults: capability.defaults,
      candidates: selection.candidates,
    });
  }
  const mappings = new Map<string, CapabilityMapping>();
  const expanded: ExpandedCapability[] = [];
  for (const capability of orderCapabilities(design)) {
    const selection = selections.get(capability.id)!;
    const { context, allocated } = loweringContext(capability, design, profile, mappings);
    const validated = validateLowering(synchronousResult(selection.adapter.lower(capability, context), 'adapter lower'), capability, selection.adapter, allocated);
    const mapping: CapabilityMapping = {
      capabilityId: capability.id, capabilityPath: capability.path, adapterId: selection.adapter.id,
      targetId: profile.target.id, mode: selection.adapter.mode,
      resourceIds: validated.lowering.resources.map(resource => resource.id).sort(),
      entryPoints: validated.entries.sort(), exitPoints: validated.exits.sort(),
      groupId: 'capability-' + capability.id.slice(0, 80) + '-' + fingerprint({ capabilityId: capability.id }).slice(0, 16),
    };
    mappings.set(capability.id, freeze(mapping));
    expanded.push({ mapping, resources: validated.lowering.resources, relations: validated.lowering.internalRelations ?? [],
      propertyOrigins: validated.lowering.propertyOrigins ?? [] });
  }
  const graph = expandGraph(design, expanded, decisions);
  const body = {
    kind: 'system-binding' as const, version: 1 as const,
    profileId: profile.id, targetId: profile.target.id, target: profile.target,
    designDigest: design.digest, graph,
    decisions: decisions.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)),
    mappings: [...mappings.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)),
  };
  const binding = freeze({ ...body, digest: fingerprint(body) });
  const handles = designHandles(input);
  if (handles) registerDesignHandles(binding, handles);
  return binding;
}
