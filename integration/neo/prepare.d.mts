export interface NeoSnapshot {
  source: string;
  commit: string;
  context: string;
  sourceName: string;
  mode: 'local-sqlite-fixture';
  createdAt: string;
}
export function prepareNeo(sourceDirectory: string, options?: { artifactsDirectory?: string }): NeoSnapshot;
