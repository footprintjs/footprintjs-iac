import { identifier } from '../graph/data.ts';
import { readReleaseChoice, readResolvedReleaseChoice, releaseText } from './data.ts';
import type { ReleaseCatalog, ReleaseChoice, ResolvedReleaseChoice } from './types.ts';

export interface GitHubReleaseCatalogOptions {
  id:string;repository:string;includePrereleases?:boolean;pageSize?:number;maxPages?:number;
  /** Enterprise API and clone roots are explicit host settings; credentials are never URL data. */
  apiBase?:string;webBase?:string;apiVersion?:string;timeoutMs?:number;
  token?:()=>Promise<string|undefined>;fetch?:typeof fetch;
}
type GitObject={sha:string;type:'tag'|'commit'};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid GitHub response');return value as Record<string,unknown>;}
function sha(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))throw Error('Invalid GitHub object identity');return value;}
function gitObject(value:unknown):GitObject{const row=object(value);if(row.type!=='commit'&&row.type!=='tag')throw Error('Release must resolve to a commit');return{sha:sha(row.sha),type:row.type};}
function root(value:string):string{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Configure a credential-free HTTPS GitHub endpoint');return url.href.replace(/\/$/,'');}
function limit(value:number|undefined,fallback:number,max:number):number{const result=value??fallback;if(!Number.isSafeInteger(result)||result<1||result>max)throw Error('Invalid GitHub catalog bound');return result;}

/** Read-only source discovery. A GitHub release is resolved, then built/sealed by a separate workflow. */
export class GitHubReleaseCatalog implements ReleaseCatalog {
  readonly id:string;private readonly options:GitHubReleaseCatalogOptions;
  private readonly api:string;private readonly web:string;private readonly pageSize:number;private readonly maxPages:number;
  private readonly transport:typeof fetch;private discovered=new Map<string,ReleaseChoice>();
  private resolved=new Map<string,ResolvedReleaseChoice>();
  /** Explicit disclosure when the configured pagination limit may omit older releases. */
  truncated=false;
  constructor(options:GitHubReleaseCatalogOptions){
    this.id=identifier(options.id,'release catalog');
    if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(options.repository)||/\/(?:\.|\.\.)$/.test(options.repository))throw Error('Configure owner/repository');
    this.options={...options};this.api=root(options.apiBase??'https://api.github.com');this.web=root(options.webBase??'https://github.com');
    this.pageSize=limit(options.pageSize,30,100);this.maxPages=limit(options.maxPages,4,10);this.transport=options.fetch??fetch;
    limit(options.timeoutMs,10000,60000);if(options.apiVersion!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(options.apiVersion))throw Error('Invalid GitHub API version');
  }
  async list():Promise<readonly ReleaseChoice[]>{
    const discovered=new Map<string,ReleaseChoice>();let lastFull=false;
    for(let page=1;page<=this.maxPages;page++){
      const rows=await this.get('/releases?per_page='+this.pageSize+'&page='+page);
      if(!Array.isArray(rows)||rows.length>this.pageSize)throw Error('Invalid GitHub release page');
      for(const row of rows){const choice=this.choice(row);if(choice){if(discovered.has(choice.id))throw Error('Duplicate GitHub release identity');discovered.set(choice.id,choice);}}
      lastFull=rows.length===this.pageSize;if(!lastFull)break;
    }
    this.discovered=discovered;this.resolved=new Map();this.truncated=lastFull;
    return [...discovered.values()].sort((a,b)=>(b.publishedAt??'').localeCompare(a.publishedAt??''));
  }
  async resolve(id:string):Promise<ResolvedReleaseChoice>{
    const selected=this.discovered.get(id);if(!selected)throw Error('Choose a discovered release ID');
    const pinned=this.resolved.get(id);if(pinned)return pinned;
    const numeric=id.slice('github-'.length),fresh=this.choice(await this.get('/releases/'+numeric));
    if(!fresh||fresh.id!==id||fresh.source.ref!==selected.source.ref)throw Error('GitHub release changed; refresh and review it again');
    const tag=selected.source.ref.slice('refs/tags/'.length);
    const ref=object(await this.get('/git/ref/tags/'+tag.split('/').map(encodeURIComponent).join('/')));
    if(ref.ref!==selected.source.ref)throw Error('GitHub returned a different release reference');
    let pointer=gitObject(ref.object);const seen=new Set<string>();
    for(let depth=0;pointer.type==='tag';depth++){
      if(depth>=8||seen.has(pointer.sha))throw Error('GitHub tag chain exceeds limits');seen.add(pointer.sha);
      const tagObject=object(await this.get('/git/tags/'+pointer.sha));if(tagObject.sha!==pointer.sha)throw Error('GitHub tag identity changed');pointer=gitObject(tagObject.object);
    }
    const commit=object(await this.get('/git/commits/'+pointer.sha));
    if(commit.sha!==pointer.sha)throw Error('GitHub commit identity changed');const tree=sha(object(commit.tree).sha);
    const resolved=readResolvedReleaseChoice({...fresh,source:{...fresh.source,commit:pointer.sha,tree}});
    if(this.discovered.get(id)!==selected)throw Error('Release catalog refreshed during resolution; choose again');
    const concurrent=this.resolved.get(id);
    if(concurrent&&(concurrent.source.commit!==resolved.source.commit||concurrent.source.tree!==resolved.source.tree))throw Error('Release reference changed during resolution; review it again');
    this.resolved.set(id,resolved);return resolved;
  }
  private choice(input:unknown):ReleaseChoice|undefined{
    const row=object(input);if(typeof row.draft!=='boolean'||typeof row.prerelease!=='boolean')throw Error('Invalid GitHub release visibility');
    if(row.draft||row.prerelease&&!this.options.includePrereleases)return;
    if(!Number.isSafeInteger(row.id)||(row.id as number)<1)throw Error('Invalid GitHub release identity');
    const tag=releaseText(row.tag_name,240);
    if(!tag||tag.startsWith('/')||tag.endsWith('/')||tag.includes('..')||tag.includes('@{')||/[\s~^:?*\[\\]/.test(tag)||tag.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.')||part.endsWith('.lock')))throw Error('Invalid GitHub release tag');
    return readReleaseChoice({id:'github-'+row.id,label:typeof row.name==='string'&&row.name.trim()?row.name:tag,version:tag,
      source:{repository:this.web+'/'+this.options.repository+'.git',ref:'refs/tags/'+tag},
      ...(row.published_at?{publishedAt:row.published_at}:{}),url:this.web+'/'+this.options.repository+'/releases/tag/'+tag.split('/').map(encodeURIComponent).join('/')});
  }
  private async get(path:string):Promise<unknown>{
    const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':this.options.apiVersion??'2026-03-10'};
    // Credentials live only in the request. Never include transport errors or response bodies in diagnostics.
    try{
      const token=await this.options.token?.();if(token){if(/[\r\n]/.test(token)||token.length>4096)throw Error('Invalid token');headers.Authorization='Bearer '+token;}
      const response=await this.transport(this.api+'/repos/'+this.options.repository+path,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(this.options.timeoutMs??10000)});
      if(!response.ok){await response.body?.cancel();throw Error('http-'+response.status);}
      const reader=response.body?.getReader();if(!reader)throw Error('Missing response');let bytes=0;const chunks:Uint8Array[]=[];
      try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>2*1024*1024)throw Error('oversized');chunks.push(item.value);}}
      finally{await reader.cancel();}
      const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
    }catch(error){
      const message=error instanceof Error?error.message:'';throw Error(/^http-\d{3}$/.test(message)?'GitHub catalog request failed ('+message.slice(5)+')':'GitHub catalog request could not be completed');
    }
  }
}
