import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Source, built output and installed packages share the owning package's artifact root. */
function packageRoot(start: string): string {
  let directory = start;
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name?: string };
      if (metadata.name === 'footprintjs-iac') return directory;
    } catch { /* Continue through ordinary source/build directories. */ }
    const parent = dirname(directory); if (parent === directory) throw new Error('Identity integration package root is unavailable');
    directory = parent;
  }
}
export const identityPackageRoot = packageRoot(import.meta.dirname);
export const identityRoot = resolve(identityPackageRoot, '.artifacts/identity');
