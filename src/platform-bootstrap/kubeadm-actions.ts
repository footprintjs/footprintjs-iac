import { posix } from 'node:path';
import type { HostAction } from '../platform-access/types.ts';
import { jsonCopy } from '../graph/data.ts';
import { digest, identifier, object } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';

export const KUBEADM_ACTION_COMPLETE = 'FOOTPRINT_KUBEADM_ACTION_COMPLETE_V1';
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
function path(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !posix.isAbsolute(value) || value.split('/').includes('..')
    || /[\x00-\x1f\x7f]/.test(value)) throw new ClusterBootstrapAdapterError('invalid-kubeadm-registration');
  return value;
}
export interface KubeadmActionRegistration {
  id: string;
  phase: 'initialize' | 'join' | 'network';
  binary: string;
  /** An approved host-local config or CNI manifest. It is never loaded into a recorder. */
  configurationFile: string;
  configurationSha256: string;
  /** Required for CNI apply; the generated kubeconfig remains on its management host. */
  kubeconfigFile?: string;
}

/** Trusted host factory, not a script deserializer. No download, reset or preflight bypass is emitted. */
export function createKubeadmHostAction(input: KubeadmActionRegistration): HostAction {
  input = object(jsonCopy(input), ['id', 'phase', 'binary', 'configurationFile', 'configurationSha256', 'kubeconfigFile']) as unknown as KubeadmActionRegistration;
  const id = identifier(input.id), binary = path(input.binary), config = path(input.configurationFile), hash = digest(input.configurationSha256);
  if (!['initialize', 'join', 'network'].includes(input.phase)
    || Object.keys(input).some(key => !['id', 'phase', 'binary', 'configurationFile', 'configurationSha256', 'kubeconfigFile'].includes(key))) {
    throw new ClusterBootstrapAdapterError('invalid-kubeadm-registration');
  }
  const network = input.phase === 'network';
  if (network !== (input.kubeconfigFile !== undefined)) throw new ClusterBootstrapAdapterError('invalid-kubeadm-registration');
  const kubeconfig = network ? path(input.kubeconfigFile) : undefined;
  const clean = network ? '' : `
for marker in /etc/kubernetes/admin.conf /etc/kubernetes/kubelet.conf /var/lib/etcd/member /etc/rancher/k3s/k3s.yaml /var/lib/rancher/k3s /etc/rancher/rke2/rke2.yaml /var/snap/microk8s/current; do
  [ ! -e "$marker" ] || exit 72
done
`;
  const command = network
    ? `${quote(binary)} --kubeconfig ${quote(kubeconfig!)} apply --server-side=true --field-manager=footprint-bootstrap -f "$work/config"`
    : `${quote(binary)} ${input.phase === 'initialize' ? 'init' : 'join'} --config "$work/config"${input.phase === 'initialize' ? ' --skip-token-print' : ''}`;
  const script = `set -eu
umask 077
[ -x ${quote(binary)} ] && [ -f ${quote(config)} ] && [ ! -L ${quote(config)} ] || exit 70
work=$(mktemp -d /tmp/footprint-kubeadm.XXXXXXXX)
trap 'rm -rf -- "$work"' 0
trap 'exit 1' HUP INT TERM
cp -P -- ${quote(config)} "$work/config"
[ -f "$work/config" ] && [ ! -L "$work/config" ] || exit 71
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/config")
else
  actual=$(shasum -a 256 "$work/config")
fi
[ "\${actual%% *}" = ${quote(hash)} ] || exit 71
${clean}
${command} >/dev/null 2>&1
printf '%s\\n' ${quote(KUBEADM_ACTION_COMPLETE)}
`;
  return Object.freeze({ id, script, effect: 'mutating' });
}
