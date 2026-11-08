export class DeclarationScope {
  private closed = false;
  protected assertOpen(): void {
    if (this.closed) throw new Error('Declaration scope is closed');
  }
  /** @internal Owners close child scopes immediately after their synchronous callback. */
  close(): void { this.closed = true; }
}
export function invokeScope<T extends DeclarationScope>(scope: T, callback: (scope: T) => T | void): void {
  try {
    if (typeof callback !== 'function') throw new Error('A scoped declaration requires a callback');
    if (/^async\b/.test(Function.prototype.toString.call(callback))) throw new Error('Declaration callbacks must be synchronous');
    const result: unknown = callback(scope);
    if (result !== undefined && result !== scope) {
      // A synchronous callback may return a native Promise. Refuse it and consume rejection;
      // its captured scope is closed by finally before any later continuation can mutate it.
      if (result instanceof Promise) void result.catch(() => undefined);
      throw new Error('Declaration callbacks must be synchronous and return their own scope or undefined');
    }
  } finally { scope.close(); }
}
