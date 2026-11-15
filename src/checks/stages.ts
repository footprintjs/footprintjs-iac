import { canonical } from '../util.ts';
import { CheckRunnerRegistry } from './registry.ts';
import { readCheckResult } from './data.ts';
import type { CheckScope } from './scope.ts';
import type { CheckExecutionState, CheckRequest, CheckResult } from './types.ts';

export interface CheckStages {
  state: CheckExecutionState; registry: CheckRunnerRegistry; persist(): Promise<void>;
}
/** Tool receipts can contain host-local paths; the native trace carries only identities and safe artifacts. */
export function recordedCheckResult(result: CheckResult): CheckResult {
  const { receipt, ...safe } = readCheckResult(result);
  return { ...safe, ...(receipt?.runId ? { receipt: { runId: receipt.runId } } : {}) };
}
export function admitCheckStage(config: CheckStages) {
  return async (scope: CheckScope) => {
    scope.setValue('request', config.state.request); scope.setValue('runnerId', config.state.runnerId);
    scope.setValue('bindingDigest', config.state.bindingDigest);
    // This read records the exact immutable release, environment and suite identity used by the next stage.
    if (canonical(scope.getValue('request')) !== canonical(config.state.request)) throw Error('Check binding differs');
  };
}
export function runCheckStage(config: CheckStages) {
  return async (scope: CheckScope) => {
    const request = scope.getValue('request') as CheckRequest;
    if (canonical(request) !== canonical(config.state.request) || scope.getValue('runnerId') !== config.state.runnerId
      || scope.getValue('bindingDigest') !== config.state.bindingDigest) throw Error('Check binding differs');
    await config.persist(); // The durable running intent precedes external tool invocation.
    config.state.result = await config.registry.run(config.state.runnerId, request);
    scope.setValue('result', recordedCheckResult(config.state.result));
    await config.persist();
  };
}
export function evaluateCheckStage(config: CheckStages) {
  return async (scope: CheckScope) => {
    if (!config.state.result || canonical(scope.getValue('result')) !== canonical(recordedCheckResult(config.state.result))) throw Error('Check result differs');
    const eligible = config.state.result.status === 'passed';
    scope.setValue('eligible', eligible);
    if (!eligible) throw Error('The registered suite did not pass. Its measured result is retained.');
  };
}
