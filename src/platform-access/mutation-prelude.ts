import { HostAccessError } from './error.ts';
import type { HostAction, HostOperationContext } from './types.ts';

/** The final identity comparison and registered action share one remote process/script. */
export function admittedHostScript(action: HostAction, context: HostOperationContext): string {
  if (action.effect === 'read-only') return action.script;
  const expected = context.expectedIdentityDigest;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new HostAccessError('host-action-not-admitted');
  return `set -eu\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\n`
    + `machine=\nif [ -r /etc/machine-id ]; then machine=$(awk 'NF { print; exit }' /etc/machine-id); fi\n`
    + `if [ -z "$machine" ] && [ -r /sys/class/dmi/id/product_uuid ]; then machine=$(awk 'NF { print; exit }' /sys/class/dmi/id/product_uuid); fi\n`
    + `identity=\nif [ -n "$machine" ] && command -v sha256sum >/dev/null 2>&1; then identity=$(printf '%s' "$machine" | sha256sum | awk '{print $1}'); fi\n`
    + `if [ "$identity" != '${expected}' ]; then printf '%s\\n' 'host-identity-unverified' >&2; exit 77; fi\n`
    + action.script;
}
