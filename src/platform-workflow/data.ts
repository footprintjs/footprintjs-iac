import { jsonCopy } from '../graph/data.ts';
import { identifier as hostIdentifier } from '../platform-access/data.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import { readBootstrapActionReceipt, readBootstrapPlan } from '../platform-bootstrap/data.ts';
import { readConnectionProfileChoices, readResourceHandle } from '../resource-flow/data.ts';
import type { PlatformBootstrapState, PlatformRecording } from './types.ts';

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const own = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Invalid platform state');
  return value as Record<string, unknown>;
};
export function readPlatformBootstrapState(input: unknown): PlatformBootstrapState {
  try {
    const state = own(jsonCopy(input), ['version', 'kind', 'bindingDigest', 'executionId', 'status', 'facts', 'plan', 'actions', 'resource', 'accessProfileId', 'publicationStatus', 'recordings', 'pause', 'errorCode']);
    if (state.version !== 1 || state.kind !== 'platform-bootstrap-state' || !digest(state.bindingDigest)
      || !['idle', 'running', 'paused', 'passed', 'blocked', 'failed', 'incomplete'].includes(String(state.status))) throw Error();
    if (state.executionId !== null) hostIdentifier(state.executionId);
    if (state.status !== 'idle' && state.executionId === null) throw Error();
    if (state.facts !== undefined) {
      if (!Array.isArray(state.facts) || state.facts.length > 64) throw Error();
      state.facts = state.facts.map(readHostFactsSnapshot);
    }
    if (state.plan !== undefined) state.plan = readBootstrapPlan(state.plan);
    if (!Array.isArray(state.actions) || state.actions.length > 64) throw Error();
    const actionIds = new Set();
    for (const inputAction of state.actions) {
      const action = own(inputAction, ['id', 'hostId', 'actionDigest', 'status', 'receipt']);
      hostIdentifier(action.id); hostIdentifier(action.hostId);
      if (actionIds.has(action.id) || !digest(action.actionDigest) || !['pending', 'started', 'completed', 'uncertain'].includes(String(action.status))) throw Error();
      actionIds.add(action.id);
      if (action.receipt !== undefined) {
        const receipt = readBootstrapActionReceipt(action.receipt);
        if (receipt.actionId !== action.id || receipt.hostId !== action.hostId) throw Error();
        action.receipt = receipt;
      }
      if (action.status === 'completed' && !action.receipt) throw Error();
    }
    if (state.resource !== undefined) state.resource = readResourceHandle(state.resource);
    if (state.accessProfileId !== undefined) hostIdentifier(state.accessProfileId);
    if (state.publicationStatus !== undefined && !['started', 'completed', 'uncertain'].includes(String(state.publicationStatus))) throw Error();
    if (!Array.isArray(state.recordings) || state.recordings.length > 128) throw Error();
    for (const value of state.recordings) {
      const recording = own(value, ['phase', 'runId', 'evidencePath', 'tracePath', 'complete', 'status', 'resumedFromRunId']);
      if (!['assessment', 'execution'].includes(String(recording.phase)) || typeof recording.complete !== 'boolean'
        || !['passed', 'paused', 'failed', 'incomplete'].includes(String(recording.status))) throw Error();
      hostIdentifier(recording.runId);
      if (recording.resumedFromRunId !== undefined) hostIdentifier(recording.resumedFromRunId);
      for (const field of ['evidencePath', 'tracePath']) if (typeof recording[field] !== 'string' || !(recording[field] as string).length || (recording[field] as string).length > 4096) throw Error();
    }
    if (state.pause !== undefined) {
      const pause = own(state.pause, ['token', 'prompt', 'profiles']);
      if (!digest(pause.token) || typeof pause.prompt !== 'string' || pause.prompt.length > 256) throw Error();
      pause.profiles = readConnectionProfileChoices(pause.profiles, { allowEmpty: true });
    }
    if ((state.status === 'paused') !== Boolean(state.pause)) throw Error();
    if (state.errorCode !== undefined && (typeof state.errorCode !== 'string' || !/^platform-[a-z-]{1,100}$/.test(state.errorCode))) throw Error();
    if (state.status === 'passed' && (!state.resource || !state.accessProfileId || !state.plan || state.actions.some(value => (value as {status:string}).status !== 'completed')
      || state.recordings.some(value => !(value as PlatformRecording).complete))) throw Error();
    return state as unknown as PlatformBootstrapState;
  } catch { throw Error('Invalid or unsupported platform bootstrap state'); }
}
