import { decide, flowChart } from 'footprintjs';
import { ConnectionScope, connectionScopeFactory } from './scope.ts';
import { checkingStage, loadConnectionsStage, outcomeStage, probeStage, summarizeConnectionsStage } from './stages.ts';
import type { ConnectionAdapter, ConnectionCheckRequest } from './types.ts';

/** The only file that constructs the native, serial connection-check flowchart. */
export function createConnectionChart(graphDigest: string, requests: readonly ConnectionCheckRequest[], adapter: ConnectionAdapter, runId: string) {
  let chart = flowChart<void, ConnectionScope>('Load declared connections', loadConnectionsStage(graphDigest, requests), 'load-connections')
    .setScopeFactory(connectionScopeFactory);
  for (const request of requests) {
    const id = request.connectionId, connected = `connected-${id}`, failed = `failed-${id}`;
    chart = chart.addFunction(`Checking ${id}`, checkingStage(id, runId), `checking-${id}`)
      .addFunction(`Probe ${id}`, probeStage(id, adapter), `probe-${id}`)
      .addDeciderFunction(`Connection outcome: ${id}`, scope => decide(scope, [
        { when: { probeFailed: { eq: false } }, then: connected, label: 'The adapter returned a verified observation' },
      ], failed), `outcome-${id}`)
      .addFunctionBranch(connected, `Connected ${id}`, outcomeStage(id, runId, 'connected'))
      .addFunctionBranch(failed, `Failed ${id}`, outcomeStage(id, runId, 'failed'))
      .setDefault(failed).end();
  }
  return chart.addFunction('Summarize connection checks', summarizeConnectionsStage, 'summarize-connections').build();
}
