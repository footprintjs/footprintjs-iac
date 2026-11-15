/** Stable, public refusal codes. Provider error bodies and reference values are never included. */
export class KubernetesWorkloadPreflightError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Kubernetes workload preflight refused: ${code}.`);
    this.name = 'KubernetesWorkloadPreflightError';
    this.code = code;
  }
}

/** Provider failures remain uncertain after a send; this is deliberately not a preflight refusal. */
export class KubernetesWorkloadAdapterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Kubernetes workload provider failed: ${code}.`);
    this.name = 'KubernetesWorkloadAdapterError';
    this.code = code;
  }
}
