import type { ServiceHandle } from '../system/handles.ts';

/** Missing, expired and revoked tokens have the same result. Backend errors propagate. */
export interface SessionReader {
  read(token: string): Promise<string | null>;
}

/** Use a separately authenticated issuer. Every newly generated token has a finite lifetime. */
export interface SessionIssuer {
  issue(value: string, lifetimeMs: number): Promise<string>;
  revoke(token: string): Promise<void>;
}

export interface SessionStoreAdapter<Client> {
  readerRole(service: ServiceHandle): string;
  reader(client: Client): SessionReader;
  issuer(client: Client): SessionIssuer;
}

export function validToken(token: string): boolean {
  return typeof token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token);
}

export function encodeSession(value: string): string {
  if (typeof value !== 'string') throw new Error('Session value must be a string');
  return JSON.stringify(value);
}

export function decodeSession(encoded: unknown): string | null {
  if (encoded === null) return null;
  if (typeof encoded === 'string') {
    const value: unknown = JSON.parse(encoded);
    if (typeof value === 'string') return value;
  }
  throw new Error('Unexpected session value from backend');
}
