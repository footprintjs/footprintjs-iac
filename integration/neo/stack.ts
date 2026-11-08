import type { Stack } from '../../src/types.ts';

export const NEO_NAMESPACE = 'footprint-iac-neo-test';

/** An isolated, ephemeral local fixture. No production stores or model credentials. */
export function createNeoStack(options: { nodeImage?: string; pythonImage?: string } = {}): Stack {
  const labels = {
    'app.kubernetes.io/name': 'neo-agentfootprint',
    'app.kubernetes.io/instance': NEO_NAMESPACE,
    'app.kubernetes.io/part-of': 'footprint-iac-local-trial',
  };
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
  };
  const probes = (path: string, port: string) => ({
    startupProbe: { httpGet: { path, port }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 90 },
    readinessProbe: { httpGet: { path, port }, periodSeconds: 3, timeoutSeconds: 2 },
    livenessProbe: { httpGet: { path, port }, periodSeconds: 15, timeoutSeconds: 3, failureThreshold: 4 },
  });
  return {
    name: NEO_NAMESPACE,
    resources: [
      {
        id: 'neo-namespace', provider: 'kubernetes',
        spec: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NEO_NAMESPACE, labels } },
      },
      {
        id: 'neo-app', provider: 'kubernetes', dependsOn: ['neo-namespace'],
        spec: {
          apiVersion: 'apps/v1', kind: 'Deployment',
          metadata: { name: 'neo', namespace: NEO_NAMESPACE, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { 'app.kubernetes.io/instance': NEO_NAMESPACE } },
            template: {
              metadata: { labels },
              spec: {
                automountServiceAccountToken: false,
                securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
                containers: [
                  {
                    name: 'node', image: options.nodeImage ?? 'footprint-iac/neo-node:local', imagePullPolicy: 'Never',
                    securityContext: { ...securityContext, runAsUser: 1000, runAsGroup: 1000 },
                    ports: [{ name: 'http', containerPort: 5230 }],
                    env: [
                      { name: 'BE_SERVER_HOST', value: '0.0.0.0' },
                      { name: 'BE_SERVER_PORT', value: '5230' },
                      { name: 'PY_TOOLS', value: '1' },
                      { name: 'SEO_MCP', value: '0' },
                      { name: 'PY_BASE_URL', value: 'http://127.0.0.1:8000' },
                    ],
                    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
                    ...probes('/health', 'http'),
                  },
                  {
                    name: 'python', image: options.pythonImage ?? 'footprint-iac/neo-python:local', imagePullPolicy: 'Never',
                    securityContext: { ...securityContext, runAsUser: 10001, runAsGroup: 10001 },
                    ports: [{ name: 'tools', containerPort: 8000 }],
                    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
                    ...probes('/healthz', 'tools'),
                  },
                ],
              },
            },
          },
        },
      },
      {
        id: 'neo-service', provider: 'kubernetes', dependsOn: ['neo-app'],
        spec: {
          apiVersion: 'v1', kind: 'Service', metadata: { name: 'neo', namespace: NEO_NAMESPACE, labels },
          spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/instance': NEO_NAMESPACE }, ports: [{ name: 'http', port: 5230, targetPort: 'http' }] },
        },
      },
    ],
  };
}
