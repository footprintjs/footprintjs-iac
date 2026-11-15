export type HostAccessErrorCode = 'invalid-host-access' | 'host-action-not-admitted' | 'host-access-unavailable' | 'host-operation-uncertain' | 'host-trust-changed';
/** Provider bodies, process output and credential values must never cross this boundary. */
export class HostAccessError extends Error {
  readonly code: HostAccessErrorCode;
  constructor(code: HostAccessErrorCode) { super(code); this.code = code; this.name = 'HostAccessError'; }
}
