import { readFile, stat } from 'node:fs/promises';
import { jsonCopy } from '../graph/data.ts';

/** Reads native evidence only. It never reruns adapters or resolves host-only source handles. */
export async function loadDeliveryRecording(path: string, expected: { runId?: string; definitionDigest?: string; executionId?: string } = {}) {
  const info = await stat(path); if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('Delivery recording exceeds local limits');
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (value.version !== 1 || value.kind !== 'delivery-native-evidence' || typeof value.runId !== 'string' || !value.runId
    || !value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot) || !value.structure || typeof value.structure !== 'object'
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) throw Error('Delivery recording differs from its expected execution');
  const snapshot = value.snapshot as { runId?: string; commitLog?: unknown; executionTree?: unknown };
  if (snapshot.runId !== value.runId || !Array.isArray(snapshot.commitLog) || !snapshot.executionTree) throw Error('Delivery native run identity differs');
  return { snapshot: jsonCopy(value.snapshot), structure: jsonCopy(value.structure),
    controlDeps: jsonCopy(value.controlDeps ?? {}), narrativeEntries: jsonCopy(value.narrative ?? []) };
}
