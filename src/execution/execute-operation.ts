import type { FailureStrategy, Observation, PlannedOperation, ResourceAdapter, StackState } from '../types.ts';
import { errorMessage, fingerprint } from '../util.ts';
import { ExecutionPersistence, PersistenceError } from './persistence.ts';
import type { OperationExecutor, OperationResult } from './types.ts';
import { createNativeOperationChart } from './create-native-operation-chart.ts';
import { checkpointIdentity, pendingResource, providerContext, readProviderObservation, verifiedResource } from './provider-state.ts';
import { resolveOperationInputs } from './operation-inputs.ts';

export interface OperationExecutionOptions {
  adapters: ReadonlyMap<string, ResourceAdapter>;
  state: StackState;
  runId: string;
  strategy: FailureStrategy;
  persistence: ExecutionPersistence;
  /** A reviewed check must not become an unreviewed repair after the plan was admitted. */
  reviewedPlan?: boolean;
}

/** Resource lifecycle policy is independent of native chart construction and batch scheduling. */
export function createOperationExecutor(options: OperationExecutionOptions): OperationExecutor {
  const execute:OperationExecutor=operation => executeOperation(operation, options);
  execute.createFlow=(operation,results)=>operation.action!=='delete'&&!operation.inputResolution
    &&(options.adapters.get(operation.resource.provider)?.createApplyFlow||options.adapters.get(operation.resource.provider)?.createVerifyFlow)
    ?createNativeOperationChart(operation,options,results):undefined;
  return execute;
}

async function executeOperation(planned: PlannedOperation, options: OperationExecutionOptions): Promise<OperationResult> {
  const { state, strategy, persistence, runId } = options;
  const adapter = options.adapters.get(planned.resource.provider)!;
  const operation = resolveOperationInputs(planned, state, adapter);
  const context = (observed?: Observation) => providerContext(state, operation.resource.id, operation.operationId, observed);
  const observedAtPlan = operation.observed.exists && operation.observed.owned === true ? operation.observed : undefined;
  const observe = async () => readProviderObservation(await adapter.observe(operation.resource, context(
    state.resources[operation.resource.id]?.physicalId === undefined ? observedAtPlan : undefined)));
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
        observed = await observe();
        await append('observed', JSON.stringify(observed));
        if (observed.exists && observed.owned !== true) throw new Error(`Refusing unowned resource: ${operation.resource.id}`);
        if (operation.action === 'delete') {
          if (observed.exists) await adapter.remove(operation.resource, context(observed));
          const after = await observe();
          if (after.exists) throw new Error(`Delete not confirmed: ${operation.resource.id}`);
          delete state.resources[operation.resource.id];
        } else {
          const old = state.resources[operation.resource.id];
          let readyContext = context(observed.exists ? observed : undefined);
          const recoveredCreate = old?.pending?.action === 'create'
            && old.pending.operationId === operation.operationId
            && old.pending.desiredFingerprint === operation.desiredFingerprint;
          if (options.reviewedPlan && ['noop', 'verify'].includes(operation.action)
            && (!observed.exists || observed.fingerprint !== operation.desiredFingerprint
              || (old && old.fingerprint !== operation.desiredFingerprint && !recoveredCreate))) {
            throw new ReviewedCheckDriftError();
          }
          if (!observed.exists || observed.fingerprint !== operation.desiredFingerprint
            || (old && old.fingerprint !== operation.desiredFingerprint && !recoveredCreate)) {
            state.resources[operation.resource.id] = pendingResource(old, operation, observed);
            await persistence.save(state); // Intent/inventory survives a killed provider call.
            const receipt = await adapter.apply(operation.resource, context());
            await checkpointIdentity(receipt, state, operation.resource.id, persistence);
            readyContext = context();
          }
          await adapter.waitReady(operation.resource, readyContext);
          observed = await observe();
          if (!observed.exists || observed.owned !== true || observed.fingerprint !== fingerprint(operation.resource.spec)) throw new Error(`Provider did not converge: ${operation.resource.id}`);
          state.resources[operation.resource.id] = verifiedResource(operation, observed, state.resources[operation.resource.id]);
        }
        await persistence.save(state);
        await append('complete', attempt > 1 ? 'Reconciled after an uncertain attempt' : undefined);
        return { status: 'complete', action: operation.action, attempts: attempt, physicalId: observed?.physicalId ?? null };
      } catch (error) {
        lastError = error;
        if (error instanceof PersistenceError) throw error;
        if (error instanceof ReviewedCheckDriftError) break;
        let reconciled: Observation | undefined;
        try { reconciled = await observe(); }
        catch { /* A failed read leaves outcome unknown, never authoritative absence. */ }
        const effectConfirmed = operation.action === 'delete'
          ? reconciled?.exists === false
          : state.resources[operation.resource.id]?.pending?.action === 'create'
            && state.resources[operation.resource.id]?.pending?.operationId === operation.operationId
            && reconciled?.exists === true && reconciled.owned === true && reconciled.fingerprint === operation.desiredFingerprint;
        if (effectConfirmed) {
          if (operation.action === 'delete') delete state.resources[operation.resource.id];
          else {
            await adapter.waitReady(operation.resource, context(reconciled));
            // The recovery observation preceded readiness; confirm the resource again before checkpointing.
            reconciled = await observe();
            if (!reconciled.exists || reconciled.owned !== true || reconciled.fingerprint !== fingerprint(operation.resource.spec)) throw new Error(`Provider did not converge: ${operation.resource.id}`);
            state.resources[operation.resource.id] = verifiedResource(operation, reconciled, state.resources[operation.resource.id]);
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

class ReviewedCheckDriftError extends Error {
  constructor() { super('A reviewed check now needs a mutation; inspect the changed resource and review again'); }
}
