import { readRecordFile } from 'footprintjs/sinks';
import type { RecordEntry } from 'foottrace/write';
import { readStoredRecord, stateAt, type CommitBundle } from 'foottrace';
import { canonical } from '../util.ts';
import { executionBranch } from '../execution/batch-stages.ts';
import { progressAdmission as require, progressBindingKey, progressCore, progressPayload, type ProgressPayload } from './admission-data.ts';
import type { DeploymentProgressAdmissionInput, AdmittedDeploymentEvent } from './admission-types.ts';
import type { DeploymentChart } from './chart.ts';
export interface NativeProgressWrite { commit: CommitBundle; count: number; terminal: ProgressPayload; native: boolean; order: number }
/** The native file owns child-log order and final facts; recorder metadata cannot omit a later write. */
export function nativeProgressWrites(input: DeploymentProgressAdmissionInput, chart: DeploymentChart | undefined, runtimeRunId: string) {
  const file = readRecordFile(input.evidence.tracePath!), record = readStoredRecord(file.entries);
  require(!file.unreadable.length && !record.unread.length && [...record.logs.values()].every(log => log.complete && !log.gaps.length));
  const ids = new Set(input.graph.resources.map(resource => resource.id)), mappings = new Map(chart?.resources.map(row => [row.resourceId, row]));
  const root = record.root(runtimeRunId); require(root);
  const writes = new Map<string, NativeProgressWrite>(), events: AdmittedDeploymentEvent[] = [];
  let fileOrder = 0;
  for (const raw of file.entries) {
    const order = fileOrder++;
    // readStoredRecord admitted every parsed file entry above.
    const entry = raw as RecordEntry;
    if (entry.kind !== 'commit') continue;
    const commit = entry.bundle, address = entry.address;
    require(address.logRunId === runtimeRunId);
    for (const id of ids) {
      const path = `progress:${id}`, traces = commit.trace.filter(row => row.path === path && row.verb === 'set');
      if (!traces.length) continue;
      const value = commit.overwrite[path];
      require(progressPayload(value, input.runId, ids) && value.resourceId === id && !!commit.runtimeStageId);
      const mapping = mappings.get(id), native = address.drillPath.length > 0;
      if (!native && mapping && commit.stageId === mapping.executeStageId
        && record.log({ logRunId: runtimeRunId, drillPath: [commit.runtimeStageId!] })) {
        // Some mapper versions forward the whole object; others record leaf paths.
        // This is a transfer of an already witnessed child result, never a second emit.
        const child = [...writes.values()].findLast(row => row.native && row.commit.stageId === `${mapping.executeStageId}/native-result`
          && row.terminal.resourceId === id);
        require(traces.length === 1 && child && canonical(value) === canonical(child.terminal));
        continue;
      }
      if (native) {
        // Resource lifecycle mounts are created by the one apply-chart constructor.
        require(mapping && address.drillPath.length === 1 && mapping.executeStageId === executionBranch(id));
        require(root.commitLog.some(parent => parent.stageId === mapping.executeStageId && parent.runtimeStageId === address.drillPath[0]));
        const lifecycle = record.log(address), operation = input.plan.operations.find(row => row.resource.id === id);
        require(lifecycle && operation);
        const seed = stateAt(lifecycle, 0).state;
        require(canonical(seed.desiredSpec) === canonical(operation.resource.spec) && seed.planAction === operation.action);
        require(['native-begin', 'native-result'].some(stage => commit.stageId === `${mapping.executeStageId}/${stage}`));
      } else if (mapping && chart) {
        require(value.status === 'pending' ? commit.stageId === chart.structure.id
          : value.status === 'skipped' ? commit.stageId === mapping.skipStageId || commit.stageId === mapping.executeStageId
          : commit.stageId === mapping.executeStageId);
      }
      const binding = progressBindingKey(commit.runtimeStageId!, id); require(!writes.has(binding));
      writes.set(binding, { commit, count: traces.length, terminal: value, native, order });
      events.push({ ...progressCore(value), runtimeStageId: commit.runtimeStageId!, sequence: events.length + 1 });
    }
  }
  // Final root state is independently replay-verified by verifyEvidenceTrace.
  for (const id of ids) {
    const event = events.findLast(event => event.resourceId === id), saved = input.evidence.snapshot.sharedState[`progress:${id}`];
    require(event && progressPayload(saved, input.runId, ids) && canonical(progressCore(saved)) === canonical(progressCore(event)));
  }
  return { writes, events };
}
