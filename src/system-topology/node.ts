import { fingerprint } from '../util.ts';
import { freeze } from '../graph/data.ts';
import { object, digest, readSystemTopologyInput, readSystemTopologyDefinition } from './data.ts';
import { readSystemTopologyView } from './view.ts';
import { identifier } from '../graph/data.ts';
import type { SystemTopologyInput, SystemTopologyBinding, SystemTopologyDefinition } from './types.ts';
export * from './index.ts';
export function defineSystemTopology(input: SystemTopologyInput, binding: SystemTopologyBinding): SystemTopologyDefinition {
    const body = readSystemTopologyInput(input), b = object(binding, ['targetId', 'graphDigest']);
    identifier(b.targetId, 'topology target');
    digest(b.graphDigest);
    const definition = { version: 1 as const, kind: 'system-topology' as const, ...body, binding: b as unknown as SystemTopologyBinding };
    return freeze({ ...definition, digest: fingerprint(definition) });
}
export function validateSystemTopologyDefinition(input: unknown): SystemTopologyDefinition {
    const value = readSystemTopologyDefinition(input), { digest: expected, ...body } = value;
    if (fingerprint(body) !== expected)
        throw Error('System topology digest differs');
    return value;
}
export function validateSystemTopologyView(input: unknown) {
    const view = readSystemTopologyView(input);
    validateSystemTopologyDefinition(view.definition);
    return view;
}
export { admitTopologyActions } from './admit-actions.ts';
