import { readFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RuntimeSnapshot } from 'footprintjs';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { canonical } from '../util.ts';
import type { PlatformBootstrapState, PlatformRecording } from './types.ts';

/** Reopens exact native evidence and trace without invoking any access or installer adapter. */
export async function readPlatformRecording(recording: PlatformRecording, bindingDigest: string, directory: string) {
  try {
  if (!recording.complete || dirname(resolve(recording.evidencePath)) !== directory || dirname(resolve(recording.tracePath)) !== directory) throw Error('Platform recording is incomplete or outside its store');
  const info = await lstat(recording.evidencePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Platform recording exceeds limits');
  const value = JSON.parse(await readFile(recording.evidencePath, 'utf8')) as {
    version: number; kind: string; phase: string; bindingDigest: string; runId: string; status: string;
    snapshot: RuntimeSnapshot; structure: unknown; tracePath: string; traceStatus: { entries: number; failed: number; flushed: boolean };
  };
  if (value.version !== 1 || value.kind !== 'platform-native-evidence' || value.phase !== recording.phase || value.runId !== recording.runId
    || value.bindingDigest !== bindingDigest || value.status !== recording.status || value.snapshot?.runId !== recording.runId || value.tracePath !== recording.tracePath || !value.structure) throw Error('Platform recording identity differs');
  await verifyEvidenceTrace({ snapshot: value.snapshot, tracePath: value.tracePath, traceStatus: value.traceStatus });
  return value;
  } catch { throw Error('The native platform recording could not be admitted'); }
}
export async function verifyPlatformStateEvidence(state: PlatformBootstrapState, directory: string): Promise<void> {
  const assessment = state.recordings.find(recording => recording.phase === 'assessment');
  if (assessment) {
    const native = await readPlatformRecording(assessment, state.bindingDigest, directory);
    if (canonical(native.snapshot.sharedState.facts) !== canonical(state.facts) || canonical(native.snapshot.sharedState.plan) !== canonical(state.plan)) throw Error('Platform assessment state differs from native evidence');
  }
  if (state.status !== 'paused' && state.status !== 'passed') return;
  const recording = state.recordings.at(-1);
  if (!assessment || !recording || recording.phase !== 'execution' || recording.status !== (state.status === 'paused' ? 'paused' : 'passed')) throw Error('Platform lifecycle has no matching execution evidence');
  const native = await readPlatformRecording(recording, state.bindingDigest, directory);
  const shared = native.snapshot.sharedState;
  if (shared.executionId !== state.executionId || shared.bindingDigest !== state.bindingDigest || canonical(shared.plan) !== canonical(state.plan)
    || canonical(shared.resource) !== canonical(state.resource)) throw Error('Platform execution differs from native evidence');
  for (const action of state.actions) if (action.status !== 'completed' || canonical(shared['receipt:' + action.id]) !== canonical(action.receipt)) throw Error('Platform action receipt differs from native evidence');
  if (state.status === 'passed' && (shared.accessProfileId !== state.accessProfileId || (shared.verification as { ok?: boolean })?.ok !== true)) throw Error('Platform access outcome differs from native evidence');
}
