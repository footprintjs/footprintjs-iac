export type ConnectionProfileErrorCode = 'invalid-schema' | 'invalid-registration' | 'unsupported-adapter'
  | 'invalid-profile' | 'profile-conflict' | 'profile-not-found' | 'secret-unavailable'
  | 'storage-unavailable' | 'connection-check-failed' | 'profile-capacity';
const messages: Record<ConnectionProfileErrorCode, string> = {
  'invalid-schema': 'The connection adapter schema is invalid',
  'invalid-registration': 'Check the connection fields and try again',
  'unsupported-adapter': 'Choose an approved connection type',
  'invalid-profile': 'The saved connection profile failed validation',
  'profile-conflict': 'A saved connection profile cannot be overwritten',
  'profile-not-found': 'The selected connection profile is unavailable',
  'secret-unavailable': 'The connection credentials are unavailable',
  'storage-unavailable': 'The connection storage is unavailable',
  'connection-check-failed': 'The connection check failed; check the supplied details',
  'profile-capacity': 'The saved connection limit has been reached; existing connections remain available',
};
/** Never wraps provider errors or echoes submitted values, paths, credentials or URLs. */
export class ConnectionProfileError extends Error {
  readonly code: ConnectionProfileErrorCode;
  constructor(code: ConnectionProfileErrorCode) {
    super(messages[code]); this.name = 'ConnectionProfileError'; this.code = code;
  }
}
