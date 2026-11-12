import { join } from 'node:path';
import { checkConnections, type ConnectionAdapter } from '../../src/connections/index.ts';
import { checkIdentityAccess, type AccessCheckAdapter } from '../../src/identity/index.ts';
import type { VerificationResult } from '../../src/resource-flow/index.ts';
import { neoIdentityCheckAdapter, neoIdentityChecks } from './checks.ts';
import { neoIdentityConnectionAdapter } from './connections.ts';
import { createIdentityGraph } from './graph.ts';
import type { IdentityTarget } from './target.ts';
import { writeNeoFlowJson } from './resource-flow-files.ts';

export interface NeoFlowVerificationOptions {
  connections?: (target: IdentityTarget) => Promise<ConnectionAdapter>;
  identity?: (target: IdentityTarget) => Promise<AccessCheckAdapter>;
}

/** Verification measures the configured consumer; it never substitutes a deployment's readiness verdict. */
export async function verifyNeoResourceFlow(target: IdentityTarget, directory: string,
  options: NeoFlowVerificationOptions = {}): Promise<VerificationResult> {
  const graph = createIdentityGraph(target, { includeNeo: true });
  const connections = await checkConnections({ graph, adapter: await (options.connections ?? neoIdentityConnectionAdapter)(target),
    traceDirectory: join(directory, 'connection-traces') });
  const connectionPath = join(directory, 'connections', connections.runId + '.json');
  await writeNeoFlowJson(connectionPath, connections);
  const identity = await checkIdentityAccess({ stack: graph.name, checks: neoIdentityChecks,
    adapter: await (options.identity ?? neoIdentityCheckAdapter)(target), traceDirectory: join(directory, 'identity-traces') });
  const identityPath = join(directory, 'identity', identity.runId + '.json');
  await writeNeoFlowJson(identityPath, identity);
  if ([connections.traceStatus, identity.traceStatus].some(capture => !capture?.flushed || capture.failed)) {
    throw Error('Neo connection or access recording is incomplete');
  }
  const checks = [
    ...Object.values(connections.checks).map(check => ({ id: check.connectionId, passed: check.status === 'connected' })),
    ...Object.values(identity.checks).map(check => ({ id: check.checkId, passed: check.status === 'passed' })),
  ];
  if (checks.length !== 10) throw Error('Neo verification did not capture all three connections and seven access checks');
  return { ok: connections.ok && identity.ok && checks.every(check => check.passed), checks,
    receipts: [{ id: 'neo-connections', runId: connections.runId, evidencePath: connectionPath },
      { id: 'neo-access', runId: identity.runId, evidencePath: identityPath }] };
}
