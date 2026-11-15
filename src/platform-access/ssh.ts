import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeze } from '../graph/data.ts';
import { bounded, identifier, readHostContext, readHostRef, registerHostActions } from './data.ts';
import { HostAccessError } from './error.ts';
import { runHostProcess } from './process.ts';
import { admittedHostScript } from './mutation-prelude.ts';
import { readPinnedAccessFile, validatePinnedKnownHosts, type PinnedAccessFile } from './ssh-files.ts';
import type { HostAccessTransport, HostAction, HostActionDescriptor, HostOperationContext, HostProcessRunner, HostRef } from './types.ts';

export interface SshHostAccessOptions {
  id?: string; host: HostRef; hostname: string; username: string; port?: number;
  knownHostsFile: string; identityFile: string; actions: readonly HostAction[];
  allowMutations?: boolean; runner?: HostProcessRunner; timeoutMs?: number; maxOutputBytes?: number;
}
/** A strict key-only management adapter. SSH credentials are private host files, never graph inputs. */
export class SshHostAccessTransport implements HostAccessTransport {
  readonly id: string; readonly host: HostRef;
  private readonly registry: ReturnType<typeof registerHostActions>;
  private readonly options: Readonly<SshHostAccessOptions>;
  private readonly timeoutMs: number; private readonly maxOutputBytes: number;
  private readonly trust: PinnedAccessFile; private readonly identity: PinnedAccessFile;
  private constructor(options: SshHostAccessOptions, trust: PinnedAccessFile, identity: PinnedAccessFile) {
    this.id = identifier(options.id ?? 'ssh-host-access'); this.host = readHostRef(options.host);
    this.registry = registerHostActions(options.actions);
    this.trust = trust; this.identity = identity;
    this.options = Object.freeze({ ...options, host: this.host, actions: [] });
    this.timeoutMs = bounded(options.timeoutMs, 10000, 100, 120000);
    this.maxOutputBytes = bounded(options.maxOutputBytes, 65536, 1024, 1048576);
  }
  static async create(options: SshHostAccessOptions): Promise<SshHostAccessTransport> {
    if (typeof options.hostname !== 'string' || !/^[A-Za-z0-9](?:[-A-Za-z0-9.]{0,251}[A-Za-z0-9])?$/.test(options.hostname)
      || typeof options.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(options.username)
      || (options.allowMutations !== undefined && typeof options.allowMutations !== 'boolean')) throw new HostAccessError('invalid-host-access');
    const admittedActions = registerHostActions(options.actions);
    const selected = { ...options, host: readHostRef(options.host),
      actions: freeze([...admittedActions.values()].map(({ id, script, effect }) => ({ id, script, effect }))),
      port: bounded(options.port, 22, 1, 65535) };
    const trust = await readPinnedAccessFile(selected.knownHostsFile, false);
    const identity = await readPinnedAccessFile(selected.identityFile, true);
    try { validatePinnedKnownHosts(trust.bytes, selected.hostname, selected.port); }
    finally { trust.bytes.fill(0); identity.bytes.fill(0); }
    return new SshHostAccessTransport(selected, trust.pin, identity.pin);
  }
  actions(): readonly HostActionDescriptor[] { return freeze([...this.registry.values()].map(({ id, digest, effect }) => ({ id, digest, effect }))); }
  async run(actionId: string, context: HostOperationContext) {
    const admittedContext = readHostContext(context); identifier(actionId);
    const action = this.registry.get(actionId);
    if (!action || (action.effect === 'mutating' && this.options.allowMutations !== true)) throw new HostAccessError('host-action-not-admitted');
    const script = admittedHostScript(action, admittedContext);
    let directory: string | undefined, attempted = false;
    let trustBytes: Buffer | undefined, identityBytes: Buffer | undefined;
    try {
      const trust = await readPinnedAccessFile(this.trust.path, false, this.trust); trustBytes = trust.bytes;
      const identity = await readPinnedAccessFile(this.identity.path, true, this.identity); identityBytes = identity.bytes;
      validatePinnedKnownHosts(trustBytes, this.options.hostname, this.options.port!);
      directory = await mkdtemp(join(tmpdir(), 'footprint-host-access-')); await chmod(directory, 0o700);
      const trustPath = join(directory, 'known-hosts'), keyPath = join(directory, 'identity');
      await writeFile(trustPath, trustBytes, { flag: 'wx', mode: 0o600 }); await writeFile(keyPath, identityBytes, { flag: 'wx', mode: 0o600 });
      const args = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${trustPath}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no',
        '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'ProxyCommand=none', '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes',
        '-o', `ConnectTimeout=${Math.max(1, Math.ceil(this.timeoutMs / 1000))}`, '-o', 'ConnectionAttempts=1',
        '-i', keyPath, '-p', String(this.options.port), '-l', this.options.username, '--', this.options.hostname, '/bin/sh', '-s'];
      attempted = true;
      const output = await (this.options.runner ?? runHostProcess)({ file: '/usr/bin/ssh', args, input: script,
        timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes });
      if (output.code !== 0 || typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > this.maxOutputBytes) throw Error();
      return { stdout: output.stdout };
    } catch (error) {
      if (!attempted && error instanceof HostAccessError && error.code === 'host-trust-changed') throw error;
      throw new HostAccessError(attempted && action.effect === 'mutating' ? 'host-operation-uncertain' : 'host-access-unavailable');
    } finally {
      trustBytes?.fill(0); identityBytes?.fill(0);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
export const createSshHostAccessTransport = (options: SshHostAccessOptions) => SshHostAccessTransport.create(options);
