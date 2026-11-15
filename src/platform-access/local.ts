import { freeze } from '../graph/data.ts';
import { bounded, identifier, readHostContext, readHostRef, registerHostActions } from './data.ts';
import { HostAccessError } from './error.ts';
import { runHostProcess } from './process.ts';
import { admittedHostScript } from './mutation-prelude.ts';
import type { HostAccessTransport, HostAction, HostActionDescriptor, HostOperationContext, HostProcessRunner, HostRef } from './types.ts';

export interface LocalHostAccessOptions {
  id?: string; host: HostRef; actions: readonly HostAction[];
  /** Explicit trusted-host authority; the default transport refuses all mutating actions. */
  allowMutations?: boolean;
  runner?: HostProcessRunner; timeoutMs?: number; maxOutputBytes?: number;
}
export class LocalHostAccessTransport implements HostAccessTransport {
  readonly id: string; readonly host: HostRef;
  private readonly registry: ReturnType<typeof registerHostActions>;
  private readonly runner: HostProcessRunner;
  private readonly timeoutMs: number; private readonly maxOutputBytes: number; private readonly allowMutations: boolean;
  constructor(options: LocalHostAccessOptions) {
    this.id = identifier(options.id ?? 'local-host-access'); this.host = readHostRef(options.host);
    this.registry = registerHostActions(options.actions); this.runner = options.runner ?? runHostProcess;
    this.timeoutMs = bounded(options.timeoutMs, 10000, 100, 120000);
    this.maxOutputBytes = bounded(options.maxOutputBytes, 65536, 1024, 1048576);
    if (options.allowMutations !== undefined && typeof options.allowMutations !== 'boolean') throw new HostAccessError('invalid-host-access');
    this.allowMutations = options.allowMutations === true;
  }
  actions(): readonly HostActionDescriptor[] { return freeze([...this.registry.values()].map(({ id, digest, effect }) => ({ id, digest, effect }))); }
  async run(actionId: string, context: HostOperationContext) {
    const admittedContext = readHostContext(context); identifier(actionId);
    const action = this.registry.get(actionId);
    if (!action || (action.effect === 'mutating' && !this.allowMutations)) throw new HostAccessError('host-action-not-admitted');
    const script = admittedHostScript(action, admittedContext);
    try {
      const output = await this.runner({ file: '/bin/sh', args: ['-s'], input: script,
        timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes });
      if (output.code !== 0 || typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > this.maxOutputBytes) throw Error();
      return { stdout: output.stdout };
    } catch { throw new HostAccessError(action.effect === 'mutating' ? 'host-operation-uncertain' : 'host-access-unavailable'); }
  }
}
