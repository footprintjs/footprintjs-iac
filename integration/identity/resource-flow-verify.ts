import { join } from 'node:path';
import { checkConnections, createConnectionRecorder, type ConnectionAdapter, type ConnectionSnapshot, type ConnectionRunResult } from '../../src/connections/index.ts';
import { checkIdentityAccess, createIdentityRecorder, type AccessCheckAdapter, type IdentitySnapshot, type IdentityRunResult } from '../../src/identity/index.ts';
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

export interface NeoFlowCheckObserver {
  connections?(snapshot: ConnectionSnapshot, result?: ConnectionRunResult): void;
  identity?(snapshot: IdentitySnapshot, result?: IdentityRunResult): void;
}

export async function checkNeoFlowConnections(target: IdentityTarget, directory: string,
  options: NeoFlowVerificationOptions = {}, observer: NeoFlowCheckObserver = {}): Promise<ConnectionRunResult> {
  const graph = createIdentityGraph(target, { includeNeo: true });
  const recorder = createConnectionRecorder({ id: 'neo-resource-flow-connections' });
  recorder.subscribe(() => observer.connections?.(recorder.getSnapshot()));
  const result = await checkConnections({ graph, adapter: await (options.connections ?? neoIdentityConnectionAdapter)(target),
    recorders: [recorder], traceDirectory: join(directory, 'connection-traces') });
  await writeNeoFlowJson(join(directory, 'connections', result.runId + '.json'), result);
  observer.connections?.(recorder.getSnapshot(), result);
  return result;
}

export async function checkNeoFlowIdentity(target: IdentityTarget, directory: string,
  options: NeoFlowVerificationOptions = {}, observer: NeoFlowCheckObserver = {}): Promise<IdentityRunResult> {
  const recorder = createIdentityRecorder({ id: 'neo-resource-flow-access' });
  recorder.subscribe(() => observer.identity?.(recorder.getSnapshot()));
  const result = await checkIdentityAccess({ stack: createIdentityGraph(target, { includeNeo: true }).name, checks: neoIdentityChecks,
    adapter: await (options.identity ?? neoIdentityCheckAdapter)(target), recorders: [recorder], traceDirectory: join(directory, 'identity-traces') });
  await writeNeoFlowJson(join(directory, 'identity', result.runId + '.json'), result);
  observer.identity?.(recorder.getSnapshot(), result);
  return result;
}

/** Verification measures the configured consumer; it never substitutes a deployment's readiness verdict. */
export async function verifyNeoResourceFlow(target: IdentityTarget, directory: string,
  options: NeoFlowVerificationOptions = {}, observer: NeoFlowCheckObserver = {}): Promise<VerificationResult> {
  const connections = await checkNeoFlowConnections(target, directory, options, observer);
  const connectionPath = join(directory, 'connections', connections.runId + '.json');
  const identity = await checkNeoFlowIdentity(target, directory, options, observer);
  const identityPath = join(directory, 'identity', identity.runId + '.json');
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
