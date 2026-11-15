import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {createHttpsKubernetesAssessmentTransport} from '../../../src/change-assessment/kubernetes.ts';
import type {KubernetesAssessmentTransport} from '../../../src/change-assessment/kubernetes.ts';
import {identityApiPort,type IdentityTarget} from '../target.ts';

/** The admitted fixture's private kubeconfig supplies TLS credentials, never browser inputs. */
export async function neoKubernetesAssessmentTransport(target:IdentityTarget):Promise<KubernetesAssessmentTransport>{
  const config=parse(await readFile(target.kubeconfig,'utf8'),{maxAliasCount:0});
  identityApiPort(config,target.context);
  const cluster=config.clusters[0].cluster,user=config.users[0].user;
  return createHttpsKubernetesAssessmentTransport({server:cluster.server,
    ca:Buffer.from(cluster['certificate-authority-data'],'base64'),
    cert:Buffer.from(user['client-certificate-data'],'base64'),key:Buffer.from(user['client-key-data'],'base64')});
}
