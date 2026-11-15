/** No raw command, stderr, credentials or provider cause crosses the recorded boundary. */
export class ClusterBootstrapAdapterError extends Error {
  readonly code: string;
  readonly effect: 'none' | 'uncertain';
  constructor(code: string, effect: 'none' | 'uncertain' = 'none') {
    if (!/^[a-z][a-z0-9-]{0,127}$/.test(code)) throw new Error('Invalid bootstrap failure code');
    super('Cluster bootstrap adapter failed');
    this.name = 'ClusterBootstrapAdapterError'; this.code = code; this.effect = effect;
    Object.freeze(this);
  }
}
