import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { validateInfraGraph } from '../graph/validation.ts';
import type { InfraGraph } from '../graph/types.ts';
import { fingerprint } from '../util.ts';
import { AGENT_CAPABILITIES, type AgentArtifactReference, type AgentDeployment, type AgentDeploymentInput, type AgentRevision, type AgentRevisionInput } from './types.ts';

export function refused(): never { throw Error('Unsupported agent-platform declaration or binding'); }
export function row(input: unknown, fields: readonly string[]): Record<string, unknown> {
 const value = jsonCopy(input);
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) refused();
 return value;
}
export function label(input: unknown, max = 160): string {
 if (typeof input !== 'string' || !input.trim() || input.length > max || /[\x00-\x1f\x7f]/.test(input)) refused(); return input;
}
export function digest(input: unknown): string { if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) refused(); return input; }
export function reference(input: unknown): string {
 const value = label(input, 4096);
 if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) { let url: URL; try { url = new URL(value); } catch { return refused(); }
  if (url.username || url.password || url.search || url.hash) refused(); }
 return value;
}
function artifact(input: unknown): AgentArtifactReference {
 const value = row(input, ['id', 'digest', 'reference']);
 return { id: identifier(value.id, 'agent artifact'), digest: digest(value.digest), ...(value.reference !== undefined ? { reference: reference(value.reference) } : {}) };
}
/** Content addresses behavior/runtime declarations; no provider or application is executed. */
export function defineAgentRevision(input: AgentRevisionInput): AgentRevision {
 const value = row(input, ['agentId', 'behavior', 'runtime']);
 const body = { version: 1 as const, agentId: identifier(value.agentId, 'agent'), behavior: artifact(value.behavior), runtime: artifact(value.runtime) };
 return freeze({ ...body, digest: fingerprint(body) });
}
export function readAgentRevision(input: unknown): AgentRevision {
 const value = row(input, ['version', 'agentId', 'behavior', 'runtime', 'digest']);
 if (value.version !== 1) refused();
 const revision = defineAgentRevision({ agentId: value.agentId as string, behavior: value.behavior as AgentArtifactReference, runtime: value.runtime as AgentArtifactReference });
 if (revision.digest !== value.digest) refused(); return revision;
}
function ids(input: unknown, maximum: number, empty = false): string[] {
 if (!Array.isArray(input) || input.length > maximum || !empty && !input.length) refused();
 const values = input.map(value => identifier(value, 'agent binding identifier')); if (new Set(values).size !== values.length) refused(); return values;
}
function deploymentBody(input: unknown, graph: InfraGraph) {
 const value = row(input, ['id', 'label', 'revision', 'target', 'resourceIds', 'environmentResourceId', 'mode', 'requiredCheckIds', 'capabilityIds', 'requiredCapabilities']);
 const target = row(value.target, ['id', 'scope']), resourceIds = ids(value.resourceIds, 256), environmentResourceId = identifier(value.environmentResourceId, 'agent environment');
 if (!['create', 'existing'].includes(String(value.mode)) || !resourceIds.includes(environmentResourceId)
  || resourceIds.some(id => !graph.resources.some(resource => resource.id === id))) refused();
 const requiredCheckIds = ids(value.requiredCheckIds, 64);
 if (requiredCheckIds.some(id => id.startsWith('agent-capability.') || id.startsWith('agent-required-'))) refused();
 const declaredCapabilities = ids(value.capabilityIds ?? [], 36, true);
 if (declaredCapabilities.some(id => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id))) refused();
 const capabilityIds = [...new Set([...AGENT_CAPABILITIES, ...declaredCapabilities])];
 if (capabilityIds.length > 36) refused();
 const requiredCapabilities = ids(value.requiredCapabilities ?? [], 36, true);
 if (requiredCapabilities.some(id => !capabilityIds.includes(id))) refused();
 return { version: 1 as const, kind: 'agent-deployment' as const, id: identifier(value.id, 'agent deployment'), label: label(value.label),
  revision: readAgentRevision(value.revision), target: { id: identifier(target.id, 'agent target'), scope: label(target.scope, 4096) },
  stack: graph.name, graphDigest: graph.digest, resourceIds, environmentResourceId, mode: value.mode as 'create' | 'existing', requiredCheckIds, capabilityIds, requiredCapabilities };
}
/** Associate the agent with real admitted infrastructure IDs, never names invented by a viewer. */
export function defineAgentDeployment(input: AgentDeploymentInput, inputGraph: InfraGraph): AgentDeployment {
 const graph = validateInfraGraph(inputGraph), body = deploymentBody(input, graph); return freeze({ ...body, digest: fingerprint(body) });
}
export function readAgentDeployment(input: unknown, inputGraph: InfraGraph): AgentDeployment {
 const graph = validateInfraGraph(inputGraph), value = row(input, ['version', 'kind', 'id', 'label', 'revision', 'target', 'stack', 'graphDigest', 'resourceIds', 'environmentResourceId', 'mode', 'requiredCheckIds', 'capabilityIds', 'requiredCapabilities', 'digest']);
 if (value.version !== 1 || value.kind !== 'agent-deployment' || value.stack !== graph.name || value.graphDigest !== graph.digest) refused();
 const { version: _version, kind: _kind, stack: _stack, graphDigest: _graphDigest, digest: saved, ...definition } = value;
 const body = deploymentBody(definition, graph); if (fingerprint(body) !== saved) refused(); return freeze({ ...body, digest: saved as string });
}
