export interface IdentityContainerSpec {
  name: string; image: string; network: 'kind'; enabled: boolean;
  role: 'directory' | 'provider';
  configDigest: string;
  mounts: { source: string; target: string }[];
  environment: string[]; envFile?: string;
  port: number; containerPort: number;
  command: string[];
  health: { url?: string; issuer?: string; caFile?: string; serverName?: string };
}
