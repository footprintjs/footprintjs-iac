import { posix } from 'node:path';
import { freeze, jsonCopy } from '../graph/data.ts';
import type { HostAction } from '../platform-access/types.ts';
import { digest, identifier, object } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';

export interface PinnedHostPreparationActionOptions {
  id: string;
  /** A reviewed artifact already delivered to the managed host. This is not a download URL. */
  recipePath: string;
  recipeSha256: string;
  interpreterPath?: string;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function path(value: unknown): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || value.length > 4096
    || value.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(value)) throw new ClusterBootstrapAdapterError('invalid-preparation-artifact');
  return value;
}

/** Register only in trusted host composition. Plans retain its action digest, never script text.
 * The artifact owns OS-specific setup and must consume host-side secret references privately.
 * Running a recipe is an effect; use the recorded workflow, target pin and mutation opt-in.
 */
export function createPinnedHostPreparationAction(input: PinnedHostPreparationActionOptions): Readonly<HostAction> {
  const value = object(jsonCopy(input), ['id', 'recipePath', 'recipeSha256', 'interpreterPath']);
  const id = identifier(value.id), recipe = path(value.recipePath), expected = digest(value.recipeSha256);
  const interpreter = path(value.interpreterPath ?? '/bin/sh');
  return freeze({ id, effect: 'mutating', script: `set -eu
umask 077
recipe=${quote(recipe)}
test -f "$recipe" && test ! -L "$recipe"
work=$(mktemp -d "${'${TMPDIR:-/tmp}'}/footprint-bootstrap.XXXXXXXX")
trap 'rm -rf -- "$work"' 0
trap 'exit 125' 1 2 15
cp -P -- "$recipe" "$work/recipe"
test -f "$work/recipe" && test ! -L "$work/recipe"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/recipe" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/recipe" | awk '{print $1}')
else
  exit 125
fi
test "$actual" = ${quote(expected)}
${quote(interpreter)} "$work/recipe" >/dev/null 2>&1
` });
}
