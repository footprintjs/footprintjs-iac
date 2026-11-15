import { readFile } from 'node:fs/promises';
export { writeNeoFlowJson as writeNeoDeliveryJson } from '../resource-flow-files.ts';

export async function readNeoDeliveryJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > 32 * 1024 * 1024) throw Error('Neo delivery evidence is too large');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
