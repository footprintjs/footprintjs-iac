import { readFile, stat } from 'node:fs/promises';
import { jsonCopy } from '../graph/data.ts';
/** Evidence replay is read-only; it cannot invoke a registered tool. */
export async function loadCheckRecording(path: string, expected: { runId?: string; bindingDigest?: string } = {}) {
  const info = await stat(path); if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('Bound check recording');
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (value.version !== 1 || value.kind !== 'check-native-evidence' || typeof value.runId !== 'string'
    || !value.snapshot || typeof value.snapshot !== 'object' || !value.structure || typeof value.structure !== 'object'
    || Object.entries(expected).some(([key, item]) => value[key] !== item)) throw Error('Check recording differs from bound invocation');
  const snapshot = value.snapshot as { runId?: string; commitLog?: unknown; executionTree?: unknown };
  if (snapshot.runId !== value.runId || !Array.isArray(snapshot.commitLog) || !snapshot.executionTree) throw Error('Invalid native check recording');
  return { snapshot: jsonCopy(value.snapshot), structure: jsonCopy(value.structure), controlDeps: jsonCopy(value.controlDeps ?? {}), narrativeEntries: jsonCopy(value.narrative ?? []) };
}
