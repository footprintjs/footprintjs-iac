import { readFile } from 'node:fs/promises';
import { connect } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation, ProviderContext, Resource, ResourceAdapter } from '../../src/types.ts';
import { fingerprint } from '../../src/util.ts';
import { command } from './command.ts';
import type { IdentityContainerSpec } from './docker-types.ts';
import { readIdentityContainerSpec } from './container-spec.ts';
import { assertIdentityContainerConfiguration, type IdentityContainer, type IdentityImage } from './container-observation.ts';
import { assertSealedIdentityFiles, identitySecretEnvironment } from './sealed-files.ts';
import { identityRoot } from './target.ts';
import { resolve } from 'node:path';

const ownerKey = 'footprint-iac.identity-owner';
const specKey = 'footprint-iac.identity-spec';
type Runner = typeof command;

/** Local-fixture provider only. Immutable container configuration; start/stop are reconciled in place. */
export class IdentityFixtureAdapter implements ResourceAdapter {
  readonly name = 'local-identity-fixture';
  readonly supportsSafeRetry = true;
  readonly scope: string;
  private readonly targetId: string;
  private readonly runner: Runner;
  private readonly fixtureRoot: string;
  private readonly imageCache = new Map<string, IdentityImage>();
  constructor(targetId: string, runner: Runner = command, fixtureRoot = identityRoot) {
    this.targetId = targetId; this.runner = runner; this.fixtureRoot = fixtureRoot;
    if (!/^[a-f0-9]{8}$/.test(targetId)) throw new Error('Invalid identity fixture target');
    this.scope = `local-docker-identity:${targetId}`;
  }
  private spec(resource: Resource): IdentityContainerSpec {
    if (resource.provider !== this.name) throw new Error('Unsupported local identity fixture declaration');
    const spec = readIdentityContainerSpec(resource.spec, this.targetId, this.fixtureRoot);
    if (resource.id !== `identity-${spec.role}`) throw new Error('Unsupported local identity fixture declaration');
    return spec;
  }
  private owner(resource: Resource, context: ProviderContext): string { return fingerprint({ stack: context.stack, id: resource.id, target: this.targetId }); }
  private async inspect(name: string): Promise<IdentityContainer | undefined> {
    // Listing first distinguishes an absent name from Docker transport/permission failure.
    const ids = await this.runner('docker', ['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (!ids) return undefined;
    if (!/^[a-f0-9]{12,64}$/.test(ids)) throw new Error('Ambiguous identity container');
    try {
      const observed = JSON.parse(await this.runner('docker', ['inspect', ids])) as IdentityContainer[];
      if (!Array.isArray(observed) || observed.length !== 1 || !observed[0] || !observed[0].Id.startsWith(ids)) throw Error();
      return observed[0];
    } catch { throw new Error('Identity container observation failed'); }
  }
  private async image(id: string): Promise<IdentityImage> {
    const cached = this.imageCache.get(id); if (cached) return cached;
    try {
      const images = JSON.parse(await this.runner('docker', ['image', 'inspect', id])) as IdentityImage[];
      if (!Array.isArray(images) || images.length !== 1 || images[0]?.Id !== id || !images[0].Config) throw Error();
      this.imageCache.set(id, images[0]); return images[0];
    } catch { throw new Error('Identity image defaults could not be verified'); }
  }
  private async validate(container: IdentityContainer, resource: Resource, context: ProviderContext, files: ReadonlyMap<string, Buffer>): Promise<IdentityContainerSpec> {
    if (container.Config?.Labels?.[ownerKey] !== this.owner(resource, context)) throw new Error('Identity container is not owned by this stack');
    let original: IdentityContainerSpec;
    try { original = readIdentityContainerSpec(JSON.parse(container.Config.Labels[specKey] ?? 'null'), this.targetId, this.fixtureRoot); }
    catch { throw new Error('Identity container configuration changed'); }
    if (fingerprint({ ...original, enabled: true }) !== fingerprint({ ...this.spec(resource), enabled: true })) {
      throw new Error('Identity fixture configuration is immutable; use a new target');
    }
    assertIdentityContainerConfiguration(container, await this.image(original.image), original,
      original.envFile ? identitySecretEnvironment(files) : []);
    return original;
  }
  async observe(resource: Resource, context: ProviderContext): Promise<Observation> {
    const spec = this.spec(resource), files = await assertSealedIdentityFiles(resolve(this.fixtureRoot, this.targetId), spec.configDigest);
    const container = await this.inspect(spec.name);
    if (!container) return { exists: false };
    const original = await this.validate(container, resource, context, files);
    const actual = { ...original, enabled: container.State.Running };
    return { exists: true, owned: true, physicalId: container.Id, fingerprint: fingerprint(actual), ready: spec.enabled === container.State.Running && (!spec.enabled || await this.healthy(spec)) };
  }
  async apply(resource: Resource, context: ProviderContext): Promise<void> {
    const spec = this.spec(resource), files = await assertSealedIdentityFiles(resolve(this.fixtureRoot, this.targetId), spec.configDigest);
    const container = await this.inspect(spec.name);
    if (container) {
      await this.validate(container, resource, context, files);
      if (container.State.Running !== spec.enabled) await this.runner('docker', [spec.enabled ? 'start' : 'stop', container.Id], 30_000);
      return;
    }
    if (!spec.enabled) throw new Error('A stopped fixture must already exist');
    await this.image(spec.image);
    const args = ['run', '-d', '--name', spec.name, '--hostname', spec.name, '--network', spec.network,
      '--memory', spec.role === 'provider' ? '768m' : '128m',
      '--label', `${ownerKey}=${this.owner(resource, context)}`, '--label', `${specKey}=${JSON.stringify(spec)}`,
      '-p', `127.0.0.1:${spec.port}:${spec.containerPort}`];
    if (spec.envFile) args.push('--env-file', spec.envFile);
    for (const variable of spec.environment) args.push('-e', variable);
    for (const mount of spec.mounts) args.push('--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`);
    args.push(spec.image, ...spec.command);
    await this.runner('docker', args, 60_000);
  }
  async remove(resource: Resource, context: ProviderContext): Promise<void> {
    const spec = this.spec(resource), files = await assertSealedIdentityFiles(resolve(this.fixtureRoot, this.targetId), spec.configDigest);
    const container = await this.inspect(spec.name);
    if (!container) return;
    await this.validate(container, resource, context, files);
    await this.runner('docker', ['rm', '-f', container.Id]);
  }
  private async healthy(spec: IdentityContainerSpec): Promise<boolean> {
    try {
      if (spec.role === 'provider') {
        const response = await fetch(spec.health.url!, { signal: AbortSignal.timeout(3000), redirect: 'error' });
        const body = await response.json() as { issuer?: string };
        return response.status === 200 && body.issuer === spec.health.issuer;
      }
      const ca = await readFile(spec.health.caFile!, 'utf8');
      return await new Promise<boolean>(accept => {
        const socket = connect({ host: '127.0.0.1', port: spec.port, servername: spec.health.serverName, ca, rejectUnauthorized: true });
        const finish = (ok: boolean) => { socket.destroy(); accept(ok); };
        socket.setTimeout(3000, () => finish(false)); socket.once('error', () => finish(false)); socket.once('secureConnect', () => finish(socket.authorized));
      });
    } catch { return false; }
  }
  async waitReady(resource: Resource, context: ProviderContext): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.observe(resource, context);
      if (observed.ready) return;
      const container = await this.inspect(this.spec(resource).name);
      if (this.spec(resource).enabled && container && !container.State.Running) throw new Error('Local identity fixture exited before readiness');
      await delay(1000);
    }
    throw new Error('Local identity fixture did not become ready');
  }
}
