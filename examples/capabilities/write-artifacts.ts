import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { systemToMermaid, systemToSvg } from '../../src/system/render.ts';
import { graphToMermaid } from '../../src/graph/render.ts';
import { graphToSvg } from '../../src/graph/svg.ts';
import type { SystemDesign } from '../../src/system/types.ts';
import type { BindingResult } from '../../src/binding/types.ts';

export const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function writeCapabilityViews(directory: string, design: SystemDesign, binding: BindingResult): Promise<void> {
  await writeJson(join(directory, 'design.json'), design);
  await writeJson(join(directory, 'binding.json'), binding);
  await writeFile(join(directory, 'intent.mmd'), systemToMermaid(design), { mode: 0o600 });
  await writeFile(join(directory, 'intent.svg'), systemToSvg(design), { mode: 0o600 });
  await writeFile(join(directory, 'resources.mmd'), graphToMermaid(binding.graph, { view: 'architecture', boundaryKind: 'group' }), { mode: 0o600 });
  await writeFile(join(directory, 'resources.svg'), graphToSvg(binding.graph, { view: 'architecture', boundaryKind: 'group' }), { mode: 0o600 });
}
