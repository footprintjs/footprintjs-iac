import { freeze, jsonCopy, keys, object } from './data.ts';

/** Public design labels. Addresses, credentials and live observations belong to the host. */
export interface CommunicationDetails {
  operation?: string;
  protocol?: { application?: string; transport?: string; port?: number };
  route?: { network?: string; via?: readonly string[] };
}

function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,95}$/.test(value)
      || value.includes('://') || value !== value.trim()) throw Error('Invalid communication ' + field);
  return value;
}

export function communicationFields(kind: unknown, input: unknown): { details?: CommunicationDetails } {
  if (input === undefined) return {};
  if (kind !== 'communicatesWith') throw Error('Connection details require communicatesWith');
  const details = object(jsonCopy(input), 'communication details');
  keys(details, ['operation', 'protocol', 'route'], 'communication details');
  if (!Object.keys(details).length) throw Error('Empty communication details');
  if (details.operation !== undefined) label(details.operation, 'operation');
  if (details.protocol !== undefined) {
    const protocol = object(details.protocol, 'protocol');
    keys(protocol, ['application', 'transport', 'port'], 'protocol');
    if (!Object.keys(protocol).length) throw Error('Empty communication protocol');
    if (protocol.application !== undefined) label(protocol.application, 'application');
    if (protocol.transport !== undefined) label(protocol.transport, 'transport');
    if (protocol.port !== undefined && (typeof protocol.port !== 'number' || !Number.isInteger(protocol.port)
        || protocol.port < 1 || protocol.port > 65535)) throw Error('Invalid communication port');
  }
  if (details.route !== undefined) {
    const route = object(details.route, 'route');
    keys(route, ['network', 'via'], 'route');
    if (!Object.keys(route).length) throw Error('Empty communication route');
    if (route.network !== undefined) label(route.network, 'network protocol');
    if (route.via !== undefined) {
      if (!Array.isArray(route.via) || route.via.length === 0 || route.via.length > 16) throw Error('Invalid communication route hops');
      for (const hop of route.via) label(hop, 'route hop');
    }
  }
  return { details: freeze(details as unknown as CommunicationDetails) };
}
