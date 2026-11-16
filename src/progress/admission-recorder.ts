import { jsonCopy } from '../graph/data.ts';
import { canonical } from '../util.ts';
import { readDeploymentChart, type DeploymentChart } from './chart.ts';
import { progressAdmission as require, progressBindingKey, progressCore, progressPayload, type ProgressPayload } from './admission-data.ts';
import type { DeploymentProgressAdmissionInput, AdmittedDeploymentEvent } from './admission-types.ts';
import type { NativeProgressWrite } from './admission-writes.ts';
/** Retain intra-stage starts only when every native write and terminal fact is represented. */
export function admitProgressRecorder(input: DeploymentProgressAdmissionInput, chart: DeploymentChart | undefined, writes: ReadonlyMap<string, NativeProgressWrite>): AdmittedDeploymentEvent[] {
  const data = jsonCopy(input.recorder) as Record<string, any>;
  require(data && data.version === 1 && data.runId === input.runId && data.ignoredEvents === 0 && data.ignoredCharts === 0 && data.subscriberFailures === 0
    && Object.keys(data).every(key => ['version','runId','sequence','resources','events','ignoredEvents','ignoredCharts','subscriberFailures','chart'].includes(key))
    && Array.isArray(data.events) && data.events.length > 0 && data.events.length <= 50_000 && data.sequence === data.events.length
    && data.resources && !Array.isArray(data.resources) && chart && canonical(readDeploymentChart(data.chart)) === canonical(chart)
    && canonical(chart.structure) === canonical(input.evidence.structure));
  const ids = new Set(input.graph.resources.map(resource => resource.id)), mappings = new Map(chart.resources.map(row => [row.resourceId, row]));
  require(Object.keys(data.resources).length === ids.size && Object.keys(data.resources).every(id => ids.has(id)));
  const events: AdmittedDeploymentEvent[] = [], latest = new Map<string, AdmittedDeploymentEvent>(), observed = new Map<string, { count: number; terminal: ProgressPayload }>();
  let loading = true, lastCompletedWriteOrder = -1;
  for (const [index, event] of data.events.entries()) {
    require(event && Object.keys(event).every(key => ['version','sequence','runId','resourceId','status','action','timestamp','runtimeStageId','message'].includes(key))
      && progressPayload(progressCore(event), input.runId, ids) && event.sequence === index + 1 && Number.isFinite(event.timestamp)
      && typeof event.runtimeStageId === 'string' && event.runtimeStageId.length > 0 && (event.message === undefined || typeof event.message === 'string'));
    const mapping = mappings.get(event.resourceId), before = latest.get(event.resourceId), key = progressBindingKey(event.runtimeStageId, event.resourceId), write = writes.get(key);
    require(mapping && write && event.action === mapping.action);
    const stage = write.commit.stageId;
    if (event.status === 'pending') require(loading && !before && !write.native && stage === chart.structure.id);
    else {
      loading = false; require(before && ['pending','deploying'].includes(before.status));
      if (event.status === 'deploying') require(before.status === 'pending' && stage === (write.native ? `${mapping.executeStageId}/native-begin` : mapping.executeStageId));
      else if (before.status === 'pending') require(event.status === 'skipped' && !write.native && stage === mapping.skipStageId);
      else require(stage === (write.native ? `${mapping.executeStageId}/native-result` : mapping.executeStageId) && ['ready','failed','skipped','deleted'].includes(event.status));
    }
    const safe = { ...progressCore(event), timestamp: event.timestamp, runtimeStageId: event.runtimeStageId, sequence: event.sequence };
    latest.set(event.resourceId, safe); events.push(safe);
    const row = observed.get(key) ?? { count: 0, terminal: progressCore(event) }; row.count++; row.terminal = progressCore(event); observed.set(key, row);
    // A legacy stage can emit its start long before its one coalesced commit.
    // At each write's final emit, native file commit order becomes authoritative.
    if (row.count === write.count) { require(write.order >= lastCompletedWriteOrder); lastCompletedWriteOrder = write.order; }
  }
  require(observed.size === writes.size);
  for (const [key, write] of writes) { const row = observed.get(key); require(row?.count === write.count && canonical(row.terminal) === canonical(progressCore(write.terminal))); }
  for (const id of ids) {
    const saved = data.resources[id], last = latest.get(id); require(last && saved && canonical({ ...saved, message: undefined }) === canonical({ ...last, message: undefined }));
  }
  return events;
}
