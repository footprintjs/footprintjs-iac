import { canonical, fingerprint } from '../../../src/util.ts';
import { readReleaseManifest } from '../../../src/releases/manifest.ts';
import type { ReleaseManifest } from '../../../src/releases/types.ts';
import type { ReleaseObservation } from '../../../src/pipeline/types.ts';
import { command } from '../command.ts';
import type { IdentityTarget } from '../target.ts';
import { join } from 'node:path';
import { neoImageConfigDigest } from './image-config.ts';

interface Meta { name: string; namespace?: string; uid: string; generation?: number; annotations?: Record<string,string>; ownerReferences?: {kind:string;uid:string;controller?:boolean}[] }
interface Container { name: string; image: string }
interface Deployment { metadata: Meta; spec: { replicas: number; selector: {matchLabels:Record<string,string>}; template: {spec:{containers:Container[]}} }; status: {observedGeneration:number;readyReplicas:number;updatedReplicas:number;availableReplicas:number} }
interface Pod { metadata: Meta; spec: {containers:Container[]}; status: {phase:string;conditions:{type:string;status:string}[];containerStatuses:{name:string;image:string;imageID:string;ready:boolean;state:{running?:unknown}}[]} }

function imageMatches(actual: string, expected: string): boolean { return actual === expected || actual === 'docker.io/' + expected; }
/** Reads actual ownership, rollout readiness, runtime image content and all known manifests. It never echoes desired release input. */
export async function observeNeoRelease(target: IdentityTarget, manifests: readonly ReleaseManifest[], run: typeof command = command): Promise<ReleaseObservation> {
  const unknown: ReleaseObservation = { known: false, releaseDigest: null };
  try {
    const kubectl = (args: string[]) => run('kubectl', ['--kubeconfig',target.kubeconfig,'--context',target.context,'--namespace',target.namespace,...args]);
    const deployment = JSON.parse(await kubectl(['get','deployment','neo','--output=json'])) as Deployment;
    if (deployment.metadata.namespace !== target.namespace || deployment.metadata.name !== 'neo' || !deployment.metadata.uid
      || deployment.metadata.annotations?.['footprint-iac.dev/owner'] !== fingerprint({stack:'neo-identity-'+target.id,id:'neo-app'})
      || canonical(deployment.spec.selector.matchLabels) !== canonical({'app.kubernetes.io/instance':target.namespace})
      || deployment.spec.replicas !== 1 || !Number.isSafeInteger(deployment.metadata.generation) || deployment.metadata.generation! < 1
      || deployment.status.observedGeneration < deployment.metadata.generation! || deployment.status.readyReplicas !== 1
      || deployment.status.updatedReplicas !== 1 || deployment.status.availableReplicas !== 1) return unknown;
    const containers = deployment.spec.template.spec.containers;
    if (!Array.isArray(containers) || containers.length !== 2 || new Set(containers.map(container=>container.name)).size !== 2) return unknown;
    const node = containers.find(container=>container.name==='node'), python = containers.find(container=>container.name==='python'); if (!node || !python) return unknown;
    const candidates = manifests.map(readReleaseManifest).filter(manifest => manifest.artifacts.length === 2
      && manifest.artifacts.find(artifact=>artifact.id==='node')?.reference === node.image
      && manifest.artifacts.find(artifact=>artifact.id==='python')?.reference === python.image);
    if (candidates.length !== 1) return unknown; // Equal images do not disambiguate different source/recipe/release identities.
    const manifest = candidates[0]!, selector = '--selector=app.kubernetes.io/instance='+target.namespace;
    const replicaSets = JSON.parse(await kubectl(['get','replicasets',selector,'--output=json'])) as {items:{metadata:Meta}[]};
    const owners = new Set(replicaSets.items.filter(set=>set.metadata.namespace===target.namespace && set.metadata.ownerReferences?.some(owner=>owner.kind==='Deployment'&&owner.uid===deployment.metadata.uid&&owner.controller)).map(set=>set.metadata.uid));
    const pods = JSON.parse(await kubectl(['get','pods',selector,'--output=json'])) as {items:Pod[]};
    const ready = pods.items.filter(pod=>pod.metadata.namespace===target.namespace && pod.metadata.uid
      && pod.metadata.ownerReferences?.some(owner=>owner.kind==='ReplicaSet'&&owners.has(owner.uid)&&owner.controller)
      && pod.status.phase==='Running' && pod.status.conditions.some(condition=>condition.type==='Ready'&&condition.status==='True')
      && pod.spec.containers.length===2 && containers.every(container=>pod.spec.containers.some(actual=>actual.name===container.name&&actual.image===container.image)));
    if (ready.length !== 1) return unknown;
    for (const artifact of manifest.artifacts) {
      const status = ready[0]!.status.containerStatuses.find(container=>container.name===artifact.id);
      if (!status?.ready || !status.state.running
        || typeof status.imageID!=='string' || !/^(?:docker-pullable:\/\/)?(?:[a-zA-Z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(status.imageID)) return unknown;
      const identity = status.imageID.replace(/^docker-pullable:\/\//,'');
      // CRI and Docker can identify different OCI objects. Attest the config from the source image archive.
      const image = JSON.parse(await run('docker',['exec',target.context.slice(5)+'-control-plane','crictl','inspecti',artifact.reference])) as {status?:{id?:string;repoTags?:string[];repoDigests?:string[]}};
      const config = await neoImageConfigDigest(artifact,{directory:join(target.directory,'release-image-configs'),runner:run});
      if (image.status?.id !== config || !image.status.repoTags?.some(tag=>imageMatches(tag,artifact.reference))
        || !image.status.repoTags.some(tag=>imageMatches(status.image,tag)||imageMatches(tag,status.image))
        || (identity.includes('@') ? !image.status.repoDigests?.includes(identity) : identity !== config)) return unknown;
    }
    return {known:true,releaseDigest:manifest.digest};
  } catch { return unknown; }
}
