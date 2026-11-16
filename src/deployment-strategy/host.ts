import { posix } from 'node:path';
import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { runHostProcess } from '../platform-access/process.ts';
import type { HostProcessRunner } from '../platform-access/types.ts';
import { readSystemdObservation, sha, unitName } from './data.ts';
import { SYSTEMD_HOST_PROGRAM } from './host-program.ts';
import type { SystemdDeploymentHost, SystemdHostObservation, SystemdUnitObservation } from './types.ts';

export interface SystemdHostUnitRegistration { name: string; workingDirectory: string }
export interface SystemdHostOptions {
  units: readonly SystemdHostUnitRegistration[]; runner?: HostProcessRunner; sudo?: boolean;
}
export interface SystemdHostBoundaryObservation extends Omit<SystemdHostObservation, 'units'> {
  units: (SystemdUnitObservation & { workingDirectory: string | null })[];
}
export interface RegisteredSystemdHost extends SystemdDeploymentHost {
  inspectBoundary(): Promise<SystemdHostBoundaryObservation>;
  inspectJobs(): Promise<{ identityDigest: string; jobs: { unit: string; jobId: string | null }[] }>;
}
const refuse = (): never => { throw Error('systemd-host-unavailable'); };
const observationKeys = 'activeState,appliedSpecDigest,configurationDigest,exists,fragmentDigest,fragmentPath,invocationId,name,workingDirectory';

/** Fixed Linux/systemd recipe over a private local, SSH or management-API process runner. */
export function createSystemdHost(options: SystemdHostOptions): RegisteredSystemdHost {
  const captured = jsonCopy(options.units) as unknown as SystemdHostUnitRegistration[];
  if (!Array.isArray(captured) || !captured.length || captured.length > 32) throw Error('systemd-host-registrations-required');
  for (const unit of captured) {
    if (!unit || Object.keys(unit).sort().join(',') !== 'name,workingDirectory') throw Error('systemd-host-registration-invalid');
    unitName(unit.name);
    if (typeof unit.workingDirectory !== 'string' || !posix.isAbsolute(unit.workingDirectory) || unit.workingDirectory.length > 4096
      || unit.workingDirectory.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(unit.workingDirectory)) throw Error('systemd-host-working-directory-required');
    unit.workingDirectory = posix.normalize(unit.workingDirectory);
  }
  if (new Set(captured.map(unit => unit.name)).size !== captured.length) throw Error('systemd-host-duplicate-unit');
  const units = freeze(captured), names = units.map(unit => unit.name);
  const workingDirectories = Object.fromEntries(units.map(unit => [unit.name, unit.workingDirectory]));
  const runner = options.runner ?? runHostProcess, sudo = options.sudo ?? process.getuid?.() !== 0;
  if (typeof runner !== 'function' || typeof sudo !== 'boolean') throw Error('systemd-host-runner-required');
  const call = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const input = JSON.stringify({ ...payload, units: names, workingDirectories });
      if (Buffer.byteLength(input) > 65536) refuse();
      const result = await runner({ file: sudo ? 'sudo' : 'python3', args: sudo ? ['-n', 'python3', '-c', SYSTEMD_HOST_PROGRAM] : ['-c', SYSTEMD_HOST_PROGRAM],
        input, timeoutMs: 90_000, maxOutputBytes: 256 * 1024 });
      if (result.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 256 * 1024) refuse();
      const value = JSON.parse(result.stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
      return value;
    } catch { return refuse(); }
  };
  const inspectBoundary = async (): Promise<SystemdHostBoundaryObservation> => {
    try {
      const value = await call({ operation: 'inspect' });
      if (Object.keys(value).sort().join(',') !== 'identityDigest,units' || !Array.isArray(value.units) || value.units.length !== units.length) refuse();
      const observedUnits = value.units as Record<string, unknown>[];
      const rows = units.map(registered => {
        const row = observedUnits.find(candidate => candidate?.name === registered.name);
        if (!row || Object.keys(row).sort().join(',') !== observationKeys || typeof row.exists !== 'boolean'
          || row.exists && (typeof row.workingDirectory !== 'string' || !posix.isAbsolute(row.workingDirectory) || posix.normalize(row.workingDirectory) !== registered.workingDirectory)
          || !row.exists && row.workingDirectory !== null) refuse();
        return row as unknown as SystemdUnitObservation & { workingDirectory: string | null };
      });
      const projected = readSystemdObservation({ identityDigest: value.identityDigest, units: rows.map(({ workingDirectory, ...unit }) => unit) });
      return freeze({ identityDigest: projected.identityDigest, units: projected.units.map((unit, index) => ({ ...unit, workingDirectory: rows[index]!.workingDirectory })) });
    } catch { return refuse(); }
  };
  const expected = (identityDigest: unknown, observed: unknown): SystemdUnitObservation[] => {
    try {
      const value = readSystemdObservation({ identityDigest: sha(identityDigest), units: observed });
      if (value.units.some(unit => !unit.exists || !names.includes(unit.name))) refuse();
      return value.units;
    } catch { return refuse(); }
  };
  return {
    inspectBoundary,
    async inspectJobs() {
      try {
        const value=await call({operation:'inspect-jobs'});
        if(Object.keys(value).sort().join(',')!=='identityDigest,jobs'||!Array.isArray(value.jobs)||value.jobs.length!==names.length)refuse();
        const identityDigest=sha(value.identityDigest),jobs=value.jobs as {unit:string;jobId:string|null}[];
        if(jobs.some((row,index)=>!row||Object.keys(row).sort().join(',')!=='jobId,unit'||row.unit!==names[index]
          ||row.jobId!==null&&(typeof row.jobId!=='string'||!/^\d{1,20}$/.test(row.jobId)||row.jobId==='0')))refuse();
        return freeze({identityDigest,jobs});
      }catch{return refuse();}
    },
    async inspect() { const value = await inspectBoundary(); return readSystemdObservation({ identityDigest: value.identityDigest, units: value.units.map(({ workingDirectory, ...unit }) => unit) }); },
    async applyUnit(request, context) {
      try {
        if (!names.includes(request.unit)) refuse(); sha(request.desiredSpecDigest); sha(request.releaseDigest); identifier(context.operationId, 'systemd operation');
        const observations = expected(context.expectedIdentityDigest, [context.expectedUnit]);
        if (observations[0]?.name !== request.unit) refuse();
        const result = await call({ operation: 'apply', request, context: { ...context, expectedUnit: observations[0] } });
        if (result.ok !== true || Object.keys(result).length !== 1) refuse();
      } catch { refuse(); }
    },
    async applyUnits(request, context) {
      try {
        if (!Array.isArray(request.units) || request.units.length !== names.length || request.units.some((name, index) => name !== names[index])) refuse();
        sha(request.desiredSpecDigest); sha(request.releaseDigest); identifier(context.operationId, 'systemd operation');
        const observations = expected(context.expectedIdentityDigest, context.expectedUnits);
        if (observations.length !== names.length || observations.some((unit, index) => unit.name !== names[index])) refuse();
        const result = await call({ operation: 'apply-group', request, context: { ...context, expectedUnits: observations } });
        if (result.ok !== true || Object.keys(result).length !== 1) refuse();
      } catch { refuse(); }
    },
  };
}
