export function smoke(nodeUrl?: string, pythonUrl?: string): Promise<{
  passed: true;
  checks: string[];
  scope: string;
}>;
