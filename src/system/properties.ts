import type { JsonObject } from '../types.ts';
import { array, jsonCopy, keys, object } from '../graph/data.ts';
import { readArtifact, readReference } from './references.ts';
import { choice, durationFields, positiveInteger, purposeValue, replicationValue, retentionValue } from './property-values.ts';
import type { CapabilityFamily, CapabilityKind } from './types.ts';

export function readProperties(input: unknown, family: CapabilityFamily, kind: CapabilityKind): JsonObject {
  const row = object(jsonCopy(input), 'capability properties');
  if (row.purpose !== undefined) purposeValue(row.purpose);
  if (family === 'storage') {
    keys(row, ['purpose', 'dataModel', 'sharing', 'durability', 'expiration', 'retention', 'replication'], 'store property');
    if (row.dataModel !== undefined) choice(row.dataModel, ['keyValue', 'relational', 'document', 'object', 'file', 'block'], 'data model');
    if (row.sharing !== undefined) choice(row.sharing, ['local', 'shared'], 'sharing');
    if (row.durability !== undefined) choice(row.durability, ['ephemeral', 'persistent'], 'durability');
    if (row.expiration !== undefined) durationFields(row.expiration, ['idle', 'absolute'], 'expiration');
    if (row.retention !== undefined) retentionValue(row.retention);
    if (row.replication !== undefined) replicationValue(row.replication);
  } else if (family === 'compute') {
    keys(row, ['purpose', 'program', 'networks', 'stores', 'runAs', 'replicas', ...(kind === 'scheduled-task' ? ['schedule'] : [])], 'compute property');
    if (row.program === undefined) throw new Error('Compute declarations require an artifact program');
    readArtifact(row.program);
    if (row.replicas !== undefined) positiveInteger(row.replicas, 'replicas');
    if (kind === 'scheduled-task') {
      if (row.schedule === undefined) throw new Error('Scheduled tasks require an interval schedule');
      durationFields(row.schedule, ['every'], 'interval schedule');
    }
    if (row.runAs !== undefined) readReference(row.runAs, 'principal');
    const networks = row.networks === undefined ? [] : array(row.networks, 'network uses').map(value => readReference(value, 'network'));
    if (new Set(networks.map(value => value.path)).size !== networks.length) throw new Error('Duplicate network use');
    if (row.networks !== undefined) row.networks = networks.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(value => jsonCopy(value));
    const stores = row.stores === undefined ? [] : array(row.stores, 'store uses').map(value => {
      const use = object(value, 'store use');
      keys(use, ['ref', 'access'], 'store use');
      choice(use.access, ['read', 'write', 'readWrite'], 'storage access');
      const reference = readReference(use.ref, 'store');
      return { ref: reference, access: use.access };
    });
    if (new Set(stores.map(value => value.ref.path)).size !== stores.length) throw new Error('Duplicate store use');
    if (row.stores !== undefined) row.stores = stores.sort((a, b) => a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : 0).map(value => jsonCopy(value));
  } else {
    keys(row, kind === 'endpoint' ? ['purpose', 'protocol', 'port', 'target'] : ['purpose'], 'network property');
    if (row.protocol !== undefined) choice(row.protocol, ['http', 'https', 'tcp', 'udp'], 'endpoint protocol');
    if (row.port !== undefined && positiveInteger(row.port, 'port') > 65535) throw new Error('Endpoint port exceeds 65535');
    if (row.target !== undefined) readReference(row.target, 'service');
  }
  return row;
}
