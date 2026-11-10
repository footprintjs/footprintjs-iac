import { canonical } from '../../src/util.ts';
import type { IdentityContainerSpec } from './docker-types.ts';

interface ImageConfig { Env?: string[]; Entrypoint?: string[] | null; Cmd?: string[] | null; User?: string; WorkingDir?: string }
export interface IdentityImage { Id: string; Config: ImageConfig }
export interface IdentityContainer {
  Id: string; Image: string; Name: string; Path: string; Args: string[];
  Config: ImageConfig & { Image: string; Hostname: string; Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Privileged?: boolean; PublishAllPorts?: boolean; PortBindings: Record<string, { HostIp: string; HostPort: string }[] | null> };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  NetworkSettings: { Networks: Record<string, { NetworkID?: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}
function environment(entries: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries) {
    const index = entry.indexOf('='); if (index < 1) throw Error();
    result.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return result;
}
const pairs = (values: ReadonlyMap<string, string>) => [...values].sort(([a], [b]) => a.localeCompare(b));
function ports(value: IdentityContainer['HostConfig']['PortBindings']) {
  return Object.entries(value).filter(([, bindings]) => bindings?.length).sort(([a], [b]) => a.localeCompare(b));
}

/** All comparisons have fixed diagnostics: observed environments can contain the resolved bind secret. */
export function assertIdentityContainerConfiguration(container: IdentityContainer, image: IdentityImage, original: IdentityContainerSpec, secretEnvironment: string[]): void {
  try {
    const expectedEnvironment = environment([...(image.Config.Env ?? []), ...secretEnvironment, ...original.environment]);
    const actualEnvironment = environment(container.Config.Env ?? []);
    if ((container.Config.Env?.length ?? 0) !== actualEnvironment.size || canonical(pairs(actualEnvironment)) !== canonical(pairs(expectedEnvironment))) throw Error();
    const expectedCommand = original.command.length ? original.command : image.Config.Cmd ?? [];
    const entrypoint = image.Config.Entrypoint ?? [];
    const invocation = [...entrypoint, ...expectedCommand];
    const expectedPorts = [[`${original.containerPort}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(original.port) }]]];
    const mounted = container.Mounts.map(mount => ({ source: mount.Source, target: mount.Destination, type: mount.Type, readonly: mount.RW === false })).sort((a, b) => a.target.localeCompare(b.target));
    const expectedMounts = original.mounts.map(mount => ({ ...mount, type: 'bind', readonly: true })).sort((a, b) => a.target.localeCompare(b.target));
    if (!/^[a-f0-9]{64}$/.test(container.Id) || container.Name !== '/' + original.name || container.Image !== original.image || image.Id !== original.image
      || container.Config.Image !== original.image || container.Config.Hostname !== original.name || container.HostConfig.Privileged === true || container.HostConfig.PublishAllPorts === true
      || container.HostConfig.NetworkMode !== original.network || canonical(Object.keys(container.NetworkSettings.Networks).sort()) !== canonical([original.network])
      || canonical(container.Config.Entrypoint ?? []) !== canonical(entrypoint) || canonical(container.Config.Cmd ?? []) !== canonical(expectedCommand)
      || (container.Config.User ?? '') !== (image.Config.User ?? '') || (container.Config.WorkingDir ?? '') !== (image.Config.WorkingDir ?? '')
      || container.Path !== invocation[0] || canonical(container.Args) !== canonical(invocation.slice(1))
      || canonical(mounted) !== canonical(expectedMounts) || canonical(ports(container.HostConfig.PortBindings)) !== canonical(expectedPorts)
      || (container.State.Running && canonical(ports(container.NetworkSettings.Ports)) !== canonical(expectedPorts))) throw Error();
  } catch { throw new Error('Identity container configuration changed'); }
}
