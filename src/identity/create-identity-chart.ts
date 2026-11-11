import { decide, flowChart } from 'footprintjs';
import { IdentityScope, identityScopeFactory } from './scope.ts';
import { identityCheckingStage, identityOutcomeStage, loadIdentityStage, observeIdentityStage, summarizeIdentityStage } from './stages.ts';
import type { AccessCheckAdapter, IdentityCheckRequest } from './types.ts';

/** The sole constructor for the native identity/access verification flowchart. */
export function createIdentityChart(stack: string, checks: readonly IdentityCheckRequest[], adapter: AccessCheckAdapter, runId: string) {
  let chart = flowChart<void, IdentityScope>('Load identity checks', loadIdentityStage(stack, checks), 'load-identity')
    .setScopeFactory(identityScopeFactory);
  for (const check of checks) {
    const id = check.id, passed = `passed-${id}`, failed = `failed-${id}`;
    chart = chart.addFunction(`Checking ${check.label}`, identityCheckingStage(id, runId), `checking-${id}`)
      .addFunction(`Observe ${check.label}`, observeIdentityStage(id, adapter), `observe-${id}`)
      .addDeciderFunction(`Expected outcome: ${check.label}`, scope => decide(scope, [
        { when: current => current.checkPassed === true, then: passed, label: 'The observation matches the declared expected outcome' },
      ], failed), `outcome-${id}`)
      .addFunctionBranch(passed, `Passed ${check.label}`, identityOutcomeStage(id, runId, 'passed'))
      .addFunctionBranch(failed, `Failed ${check.label}`, identityOutcomeStage(id, runId, 'failed'))
      .setDefault(failed).end();
  }
  return chart.addFunction('Summarize identity checks', summarizeIdentityStage, 'summarize-identity').build();
}
