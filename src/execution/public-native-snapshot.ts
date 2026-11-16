/** A display slice of the actual native snapshot. Scope payloads and private error text never cross this port. */
export function publicNativeSnapshot(input: unknown): Record<string, unknown> {
  const root = input as any; let remaining = 100000;
  const consume = () => { if (--remaining < 0) throw Error('Native display snapshot exceeds bounds'); };
  function writes(input: any): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    if (!input || typeof input !== 'object') return output;
    for (const key of ['adapterFlowPassed', 'nativeHasError']) if (typeof input[key] === 'boolean') output[key] = input[key];
    for (const key of ['adapterFlowOutcome', 'verificationFlowOutcome', 'adapterFlowProgress']) {
      const status = input[key]?.status;
      if (['passed', 'failed', 'unknown', 'running'].includes(status)) output[key] = { status };
    }
    return output;
  }
  function stages(node: any, depth = 0): any {
    consume(); if (depth > 128) throw Error('Native display tree exceeds bounds');
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(child => stages(child, depth + 1));
    const output: any = {};
    for (const key of ['id', 'runtimeStageId', 'name']) if (typeof node[key] === 'string') output[key] = node[key];
    for (const key of ['isDecider', 'isFork']) if (typeof node[key] === 'boolean') output[key] = node[key];
    if (node.errors && typeof node.errors === 'object' && Object.keys(node.errors).length) output.errors = { recordedFailure: true };
    const safeWrites = writes(node.stageWrites); if (Object.keys(safeWrites).length) output.stageWrites = safeWrites;
    if (node.next) output.next = stages(node.next, depth + 1);
    for (const key of ['children', 'branches']) if (Array.isArray(node[key])) output[key] = node[key].map((child: any) => stages(child, depth + 1));
    return output;
  }
  function history(rows: any): any[] {
    return Array.isArray(rows) ? rows.map(row => { consume(); const output: any = {};
      for (const key of ['stage', 'stageId', 'runtimeStageId', 'phase']) if (typeof row[key] === 'string') output[key] = row[key];
      if (Number.isSafeInteger(row.idx)) output.idx = row.idx;
      const overwrite = writes(row.overwrite); if (Object.keys(overwrite).length) output.overwrite = overwrite;
      return output;
    }) : [];
  }
  const output: any = { runId: root?.runId, executionTree: stages(root?.executionTree), commitLog: history(root?.commitLog) };
  const subflowResults: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(root?.subflowResults ?? {}) as [string, any][]) {
    consume(); subflowResults[key] = { ...(typeof row.subflowId === 'string' ? { subflowId: row.subflowId } : {}),
      ...(typeof row.parentStageId === 'string' ? { parentStageId: row.parentStageId } : {}),
      treeContext: { stageContexts: stages(row.treeContext?.stageContexts), history: history(row.treeContext?.history) } };
  }
  if (Object.keys(subflowResults).length) output.subflowResults = subflowResults;
  output.recorders = (root?.recorders ?? []).flatMap((row: any) => {
    if (row.id === 'iac-native-stage-progress') return [{ id: row.id, data: structuredClone(row.data) }];
    if (row.id !== 'iac-internal-control-dependencies') return [];
    return [{ id: row.id, data: { decisions: (row.data?.decisions ?? []).map((decision: any) => {
      consume(); const chosen = decision.evidence?.chosen;
      return { deciderRuntimeStageId: decision.deciderRuntimeStageId, ...(typeof chosen === 'string' || Array.isArray(chosen) ? { evidence: { chosen: structuredClone(chosen) } } : {}) };
    }) } }];
  });
  return output;
}
