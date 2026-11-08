import type { FailureStrategy, Observation, PlannedOperation, ResourceAdapter, StackState } from '../types.ts';
import { errorMessage, fingerprint } from '../util.ts';
import { ExecutionPersistence, PersistenceError } from './persistence.ts';
import type { OperationExecutor, OperationResult } from './types.ts';

export interface OperationExecutionOptions {
  adapters: ReadonlyMap<string, ResourceAdapter>;
  state: StackState;
  runId: string;
  strategy: FailureStrategy;
  persistence: ExecutionPersistence;
}

/** Resource lifecycle policy is independent of native chart construction and batch scheduling. */
export function createOperationExecutor(options: OperationExecutionOptions): OperationExecutor {
  return operation => executeOperation(operation, options);
}

async function executeOperation(operation: PlannedOperation, options: OperationExecutionOptions): Promise<OperationResult> {
  const { state, strategy, persistence, runId } = options;
  const adapter = options.adapters.get(operation.resource.provider)!;
  const context = { stack: state.stack, operationId: operation.operationId };
  const append = (event: 'begin' | 'observed' | 'complete' | 'failed', detail?: string) => persistence.append({
    event, runId, stack: state.stack, operationId: operation.operationId, resourceId: operation.resource.id,
    action: operation.action, at: new Date().toISOString(), ...(detail ? { detail } : {}),
  });
  await append('begin'); // A resource stage is admitted before it can touch the provider.
  let lastError: unknown;
  try {
    for (let attempt = 1; attempt <= strategy.maxAttempts; attempt++) {
      let observed: Observation | undefined;
      try {
        observed = await adapter.observe(operation.resource, context);
        await append('observed', JSON.stringify(observed));
        if (observed.exists && observed.owned !== true) throw new Error(`Refusing unowned resource: ${operation.resource.id}`);
        if (operation.action === 'delete') {
          if (observed.exists) await adapter.remove(operation.resource, context);
          const after = await adapter.observe(operation.resource, context);
          if (after.exists) throw new Error(`Delete not confirmed: ${operation.resource.id}`);
          delete state.resources[operation.resource.id];
        } else {
          const old = state.resources[operation.resource.id];
          const recoveredCreate = old?.pending?.action === 'create'
            && old.pending.operationId === operation.operationId
            && old.pending.desiredFingerprint === operation.desiredFingerprint;
          if (!observed.exists || observed.fingerprint !== operation.desiredFingerprint
            || (old && old.fingerprint !== operation.desiredFingerprint && !recoveredCreate)) {
            state.resources[operation.resource.id] = {
              // A rejected addition must not turn restoration into an unsupported field removal.
              resource: old?.resource ?? operation.resource, fingerprint: old?.fingerprint ?? '',
              pending: { operationId: operation.operationId, action: observed.exists ? 'update' : 'create', desiredFingerprint: operation.desiredFingerprint },
            };
            await persistence.save(state); // Intent/inventory survives a killed provider call.
            await adapter.apply(operation.resource, context);
          }
          await adapter.waitReady(operation.resource, context);
          observed = await adapter.observe(operation.resource, context);
          if (!observed.exists || observed.owned !== true || observed.fingerprint !== fingerprint(operation.resource.spec)) throw new Error(`Provider did not converge: ${operation.resource.id}`);
          state.resources[operation.resource.id] = { resource: operation.resource, fingerprint: operation.desiredFingerprint, ...(observed.physicalId ? { physicalId: observed.physicalId } : {}) };
        }
        await persistence.save(state);
        await append('complete', attempt > 1 ? 'Reconciled after an uncertain attempt' : undefined);
        return { status: 'complete', action: operation.action, attempts: attempt, physicalId: observed?.physicalId ?? null };
      } catch (error) {
        lastError = error;
        if (error instanceof PersistenceError) throw error;
        let reconciled: Observation | undefined;
        try { reconciled = await adapter.observe(operation.resource, context); }
        catch { /* A failed read leaves outcome unknown, never authoritative absence. */ }
        const effectConfirmed = operation.action === 'delete'
          ? reconciled?.exists === false
          : state.resources[operation.resource.id]?.pending?.action === 'create'
            && state.resources[operation.resource.id]?.pending?.operationId === operation.operationId
            && reconciled?.exists === true && reconciled.owned === true && reconciled.fingerprint === operation.desiredFingerprint;
        if (effectConfirmed) {
          if (operation.action === 'delete') delete state.resources[operation.resource.id];
          else {
            await adapter.waitReady(operation.resource, context);
            state.resources[operation.resource.id] = { resource: operation.resource, fingerprint: operation.desiredFingerprint, ...(reconciled?.physicalId ? { physicalId: reconciled.physicalId } : {}) };
          }
          await persistence.save(state);
          await append('complete', `Reconciled after error: ${errorMessage(error)}`);
          return { status: 'complete', action: operation.action, attempts: attempt, reconciled: true };
        }
        const decision = strategy.decide(error, reconciled, attempt);
        await append('observed', `${decision.reason}: ${errorMessage(error)}`);
        if (!adapter.supportsSafeRetry || !decision.retry) break;
      }
    }
    throw lastError ?? new Error('Reconciliation failed');
  } catch (error) {
    await append('failed', errorMessage(error));
    throw error;
  }
}
