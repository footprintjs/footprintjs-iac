import { posix } from 'node:path';
import { freeze, identifier as toolId, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { HostAccessError } from './error.ts';
import { readHostRef } from './data.ts';
import type { HostFactsSnapshot, HostToolObservation } from './types.ts';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error();
  return value as Record<string, unknown>;
}
function number(value: unknown, zero = false, fractional = false): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (zero ? 0 : Number.MIN_VALUE) || (!fractional && !Number.isSafeInteger(value))) throw Error();
  return value;
}
function text(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[-A-Za-z0-9_.+]{1,128}$/.test(value)) throw Error();
  return value;
}
function tool(value: unknown): HostToolObservation {
  const item = object(value, ['status', 'version']);
  if (!['installed', 'absent', 'unknown'].includes(item.status as string)) throw Error();
  if (item.version !== undefined && (item.status !== 'installed' || typeof item.version !== 'string' || !/^[-A-Za-z0-9_.+]{1,128}$/.test(item.version))) throw Error();
  return { status: item.status as HostToolObservation['status'], ...(item.version ? { version: item.version as string } : {}) };
}
export function hostFactsDigest(snapshot: Omit<HostFactsSnapshot, 'digest'>): string { return fingerprint(snapshot); }

/** Strict projection and digest admission before a discovery result enters native recording. */
export function readHostFactsSnapshot(input: unknown): HostFactsSnapshot {
  try {
    const value = object(jsonCopy(input), ['version', 'kind', 'host', 'observedAt', 'status', 'identityDigest', 'os', 'architecture', 'cpuCount', 'memory', 'disk', 'privilege', 'tools', 'kubernetes', 'digest']);
    if (value.version !== 1 || value.kind !== 'host-facts' || !Number.isSafeInteger(value.observedAt) || (value.observedAt as number) < 0
      || !['complete', 'partial', 'unavailable'].includes(value.status as string)) throw Error();
    if (value.identityDigest !== null && (typeof value.identityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.identityDigest))) throw Error();
    const os = object(value.os, ['family', 'distribution', 'version', 'kernel']);
    if (!['linux', 'darwin', 'windows', 'unknown'].includes(os.family as string)) throw Error();
    const memory = object(value.memory, ['totalBytes', 'availableBytes']), disk = object(value.disk, ['path', 'totalBytes', 'availableBytes']);
    if (typeof disk.path !== 'string' || !posix.isAbsolute(disk.path) || posix.normalize(disk.path) !== disk.path || /[\x00-\x1f\x7f]/.test(disk.path) || disk.path.length > 1024) throw Error();
    if (!['amd64', 'arm64', 'unknown'].includes(value.architecture as string) || !['root', 'sudo-noninteractive', 'unprivileged', 'unknown'].includes(value.privilege as string)) throw Error();
    if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools) || Object.keys(value.tools).length > 128) throw Error();
    const tools = Object.fromEntries(Object.entries(value.tools).map(([id, observation]) => [toolId(id, 'host tool'), tool(observation)]));
    const kubernetes = object(value.kubernetes, ['status']);
    if (!['present', 'absent', 'unknown'].includes(kubernetes.status as string)) throw Error();
    const projected: Omit<HostFactsSnapshot, 'digest'> = {
      version: 1, kind: 'host-facts', host: readHostRef(value.host), observedAt: value.observedAt as number,
      status: value.status as HostFactsSnapshot['status'], identityDigest: value.identityDigest as string | null,
      os: { family: os.family as HostFactsSnapshot['os']['family'], distribution: text(os.distribution), version: text(os.version), kernel: text(os.kernel) },
      architecture: value.architecture as HostFactsSnapshot['architecture'], cpuCount: number(value.cpuCount, false, true),
      memory: { totalBytes: number(memory.totalBytes), availableBytes: number(memory.availableBytes, true) },
      disk: { path: disk.path, totalBytes: number(disk.totalBytes), availableBytes: number(disk.availableBytes, true) },
      privilege: value.privilege as HostFactsSnapshot['privilege'],
      tools,
      kubernetes: { status: kubernetes.status as HostFactsSnapshot['kubernetes']['status'] },
    };
    if (projected.memory.totalBytes !== null && projected.memory.availableBytes !== null && projected.memory.availableBytes > projected.memory.totalBytes
      || projected.disk.totalBytes !== null && projected.disk.availableBytes !== null && projected.disk.availableBytes > projected.disk.totalBytes) throw Error();
    const complete = projected.identityDigest !== null && projected.os.family !== 'unknown' && projected.os.distribution !== null
      && projected.os.version !== null && projected.os.kernel !== null && projected.architecture !== 'unknown'
      && projected.cpuCount !== null && projected.memory.totalBytes !== null && projected.memory.availableBytes !== null
      && projected.disk.totalBytes !== null && projected.disk.availableBytes !== null && projected.privilege !== 'unknown'
      && projected.kubernetes.status !== 'unknown'
      && Object.values(projected.tools).every(tool => tool.status !== 'unknown' && (tool.status !== 'installed' || tool.version !== undefined));
    if (projected.status === 'complete' && !complete) throw Error();
    if (projected.status === 'unavailable' && (projected.identityDigest !== null || projected.os.family !== 'unknown'
      || projected.os.distribution !== null || projected.os.version !== null || projected.os.kernel !== null || projected.architecture !== 'unknown'
      || projected.cpuCount !== null || projected.memory.totalBytes !== null || projected.memory.availableBytes !== null
      || projected.disk.totalBytes !== null || projected.disk.availableBytes !== null || projected.privilege !== 'unknown'
      || projected.kubernetes.status !== 'unknown' || Object.values(projected.tools).some(tool => tool.status !== 'unknown'))) throw Error();
    if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || hostFactsDigest(projected) !== value.digest) throw Error();
    return freeze({ ...projected, digest: value.digest });
  } catch { throw new HostAccessError('invalid-host-access'); }
}
