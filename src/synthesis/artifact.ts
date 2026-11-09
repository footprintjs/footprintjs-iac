import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { freeze, jsonCopy, keys, object } from '../graph/data.ts';
import type { InfraGraph } from '../graph/types.ts';
import type { Json, JsonObject } from '../types.ts';
import { canonical } from '../util.ts';
import type { ArtifactFile, ArtifactMapping, OutputArtifact, OutputFormat } from './types.ts';

export function sha256(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function outputFile(path: string, document: Json, format: OutputFormat): ArtifactFile {
  const content = format === 'json' ? JSON.stringify(JSON.parse(canonical(document)), null, 2) + '\n' : stringify(document, { sortMapEntries: true, aliasDuplicateObjects: false });
  return { path, mediaType: format === 'json' ? 'application/json' : 'application/yaml', content, sha256: sha256(content) };
}
export function outputFormat(input: unknown): OutputFormat {
  if (input !== 'json' && input !== 'yaml') throw new Error('Output format must be json or yaml');
  return input;
}
export function artifactMapping(graph: InfraGraph, resourceId: string, nativeId: string, nativePath: string): ArtifactMapping {
  const mapping: ArtifactMapping = { resourceId, nativeId, nativePath, sourceKey: `resource:${resourceId}` };
  const ids = new Set(graph.memberships.filter(row => row.resourceId === resourceId).map(row => row.boundaryId));
  const origin = graph.boundaries.find(row => ids.has(row.id) && row.attributes?.origin === 'capability')?.attributes;
  for (const key of ['capabilityId', 'capabilityPath', 'designDigest'] as const) if (typeof origin?.[key] === 'string') mapping[key] = origin[key];
  return mapping;
}
export function validateArtifact(input: unknown, graph: InfraGraph, adapterId: string): OutputArtifact {
  const row = object(jsonCopy(input), 'output artifact');
  keys(row, ['adapterId', 'format', 'graphDigest', 'files', 'mappings', 'limitations', 'validation'], 'output artifact');
  if (row.adapterId !== adapterId || row.graphDigest !== graph.digest || row.validation !== 'structural') throw new Error('Output artifact identity/validation mismatch');
  outputFormat(row.format);
  if (!Array.isArray(row.files) || !row.files.length || !Array.isArray(row.mappings) || !Array.isArray(row.limitations)) throw new Error('Incomplete output artifact');
  const paths = new Set<string>();
  for (const entry of row.files) {
    const file = object(entry, 'output file');
    keys(file, ['path', 'mediaType', 'content', 'sha256'], 'output file');
    if (typeof file.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,255}$/.test(file.path)
      || file.path.split('/').some(part => part === '..' || part === '.' || !part) || paths.has(file.path)) throw new Error('Unsafe or duplicate output path');
    paths.add(file.path);
    if (typeof file.content !== 'string' || file.content.length > 8 * 1024 * 1024 || typeof file.mediaType !== 'string' || file.sha256 !== sha256(file.content)) throw new Error('Output content/hash mismatch');
    if (file.mediaType !== (row.format === 'json' ? 'application/json' : 'application/yaml')) throw new Error('Output media type disagrees with encoding');
    jsonCopy(row.format === 'json' ? JSON.parse(file.content) : parse(file.content, { maxAliasCount: 0, uniqueKeys: true }));
  }
  const expected = graph.resources.map(resource => resource.id).sort();
  const actual = row.mappings.map(entry => {
    const map = object(entry, 'artifact mapping');
    keys(map, ['resourceId', 'nativeId', 'nativePath', 'sourceKey', 'capabilityId', 'capabilityPath', 'designDigest'], 'artifact mapping');
    if (typeof map.resourceId !== 'string' || typeof map.nativeId !== 'string' || typeof map.nativePath !== 'string'
      || !map.nativePath.startsWith('/') || /~(?![01])/.test(map.nativePath)
      || map.sourceKey !== `resource:${map.resourceId}`) throw new Error('Invalid artifact source mapping');
    for (const key of ['capabilityId', 'capabilityPath', 'designDigest']) if (map[key] !== undefined && typeof map[key] !== 'string') throw new Error('Invalid capability source mapping');
    return map.resourceId;
  }).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Output resource coverage is incomplete or duplicated');
  if (new Set(row.mappings.map(entry => (entry as JsonObject).nativeId)).size !== actual.length) throw new Error('Duplicate native output identity');
  if (row.limitations.some(value => typeof value !== 'string')) throw new Error('Invalid output limitations');
  return freeze(row as unknown as OutputArtifact);
}
export function optionsRow(input: unknown): JsonObject { return object(jsonCopy(input), 'output options'); }
