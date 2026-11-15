import { createHash } from 'node:crypto';

export const fixtureDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const FIXTURE_IDENTITY = fixtureDigest('controlled-fixture-machine-a');
export interface FixtureControl {
  prepared: boolean;
  present: boolean;
  networkReady: boolean;
  version: string;
  inventoryCalls: number;
  inspections: number;
  connects: number;
  actions: string[];
}

/** Synthetic measurements are explicit fixture data, never a claim about this laptop or a server. */
export function fixtureInventory(control: FixtureControl): string {
  const installed = control.prepared ? 'installed' : 'absent';
  const values = {
    family: 'linux', distribution: 'debian', os_version: '12', kernel: '6.12.1', architecture: 'amd64', identity: FIXTURE_IDENTITY,
    cpu: '4', memory_total: String(8 * 1024 ** 3), memory_available: String(6 * 1024 ** 3),
    disk_total: String(100 * 1024 ** 3), disk_available: String(80 * 1024 ** 3), privilege: 'root',
    kubernetes: control.present ? 'present' : 'unknown',
    kubeadm: installed, 'kubeadm-version': control.prepared ? control.version : '',
    kubelet: installed, 'kubelet-version': control.prepared ? control.version : '',
    kubectl: installed, 'kubectl-version': control.prepared ? control.version : '',
    containerd: installed, 'containerd-version': control.prepared ? '2.1.0' : '',
  };
  return 'footprint-host-inventory-v1\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}
