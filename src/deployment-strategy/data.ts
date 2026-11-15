import { posix } from 'node:path';
import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import type { SystemdHostObservation, SystemdUnitBinding } from './types.ts';

export function sha(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('systemd-deployment-invalid-digest'); return value; }
export function unitName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,118}\.service$/.test(value) || value.includes('..')) throw Error('systemd-deployment-invalid-unit'); return value;
}
export function readSystemdUnits(input: readonly SystemdUnitBinding[]): readonly SystemdUnitBinding[] {
  if (!Array.isArray(input) || !input.length || input.length > 64) throw Error('systemd-deployment-units-required');
  const units = input.map(row => {
    const value = jsonCopy(row) as unknown as SystemdUnitBinding;
    if (Object.keys(value).some(key => !['id','name','fragmentPath','configurationDigest','dependsOn'].includes(key))) throw Error('systemd-deployment-invalid-binding');
    identifier(value.id,'systemd resource'); unitName(value.name); sha(value.configurationDigest);
    if (!posix.isAbsolute(value.fragmentPath) || value.fragmentPath.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(value.fragmentPath)) throw Error('systemd-deployment-invalid-fragment');
    if (value.dependsOn!==undefined) {if(!Array.isArray(value.dependsOn))throw Error('systemd-deployment-invalid-dependencies');for(const id of value.dependsOn)identifier(id,'systemd dependency');}
    return value;
  });
  if (new Set(units.map(unit => unit.id)).size !== units.length || new Set(units.map(unit => unit.name)).size !== units.length) throw Error('systemd-deployment-duplicate-unit');
  return freeze(units);
}
export function readSystemdObservation(input: unknown): SystemdHostObservation {
  const value = jsonCopy(input) as unknown as SystemdHostObservation;
  if (!value || Object.keys(value).sort().join(',') !== 'identityDigest,units' || !Array.isArray(value.units) || value.units.length > 64) throw Error('systemd-observation-invalid');
  sha(value.identityDigest);
  const names = new Set<string>();
  for (const unit of value.units) {
    if (!unit || Object.keys(unit).sort().join(',') !== 'activeState,appliedSpecDigest,configurationDigest,exists,fragmentDigest,fragmentPath,invocationId,name') throw Error('systemd-observation-invalid');
    unitName(unit.name); if (names.has(unit.name) || typeof unit.exists !== 'boolean' || !['active','inactive','failed','activating','deactivating','unknown'].includes(unit.activeState)) throw Error('systemd-observation-invalid'); names.add(unit.name);
    if (unit.fragmentDigest !== null) sha(unit.fragmentDigest); if (unit.configurationDigest !== null) sha(unit.configurationDigest); if (unit.appliedSpecDigest !== null) sha(unit.appliedSpecDigest);
    if (unit.fragmentPath !== null && (typeof unit.fragmentPath !== 'string' || !posix.isAbsolute(unit.fragmentPath) || /[\x00-\x1f\x7f]/.test(unit.fragmentPath))) throw Error('systemd-observation-invalid');
    if (unit.invocationId !== null && (typeof unit.invocationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(unit.invocationId))) throw Error('systemd-observation-invalid');
  }
  return freeze(value);
}
export const factsDigest = (facts: SystemdHostObservation) => fingerprint({...facts,units:[...facts.units].sort((a,b)=>a.name.localeCompare(b.name))});
