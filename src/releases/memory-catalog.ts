import { readReleaseManifest } from './manifest.ts';
import { readResolvedReleaseChoice } from './data.ts';
import type { ReleaseCatalog, ReleaseChoice, ReleaseManifest, ResolvedReleaseChoice } from './types.ts';
import { identifier } from '../graph/data.ts';

/** A prepared-release catalog useful for air-gapped hosts and fixed customer selections. */
export class ManifestReleaseCatalog implements ReleaseCatalog {
  readonly id:string;
  private readonly manifests:ReadonlyMap<string,ReleaseManifest>;
  constructor(id:string,inputs:readonly ReleaseManifest[]){
    if(!inputs.length||inputs.length>256)throw Error('Configure a bounded release catalog');
    this.id=identifier(id,'release catalog');const values=inputs.map(readReleaseManifest);
    if(new Set(values.map(value=>value.id)).size!==values.length)throw Error('Duplicate release ID');
    this.manifests=new Map(values.map(value=>[value.id,value]));
  }
  async list():Promise<readonly ReleaseChoice[]>{return [...this.manifests.values()].map(manifest=>this.choice(manifest));}
  async resolve(id:string):Promise<ResolvedReleaseChoice>{return this.choice(this.manifest(id));}
  manifest(id:string):ReleaseManifest{const value=this.manifests.get(id);if(!value)throw Error('Choose a registered release');return readReleaseManifest(value);}
  private choice(manifest:ReleaseManifest):ResolvedReleaseChoice{return readResolvedReleaseChoice({id:manifest.id,label:manifest.label??manifest.id,
    source:manifest.source,manifestDigest:manifest.digest});}
}
