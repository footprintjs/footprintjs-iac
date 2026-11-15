import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReleaseCatalog } from '../src/releases/github.ts';

const commit='1'.repeat(40),tree='2'.repeat(40),tagSha='3'.repeat(40);
const release=(id:number,tag='v'+id,extra:Record<string,unknown>={})=>({id,tag_name:tag,name:'Version '+id,draft:false,prerelease:false,published_at:'2026-11-'+String(id).padStart(2,'0')+'T12:00:00Z',...extra});
function fixture(options:Record<string,unknown>={}){
  const calls:{path:string;init?:RequestInit}[]=[],routes=new Map<string,unknown>([
    ['/releases?per_page=2&page=1',[release(1),release(2,'v2',{prerelease:true})]],
    ['/releases?per_page=2&page=2',[release(3,'release/v3'),release(4,'v4',{draft:true})]],
    ['/releases?per_page=2&page=3',[]],['/releases/1',release(1)],['/releases/3',release(3,'release/v3')],
    ['/git/ref/tags/v1',{ref:'refs/tags/v1',object:{type:'commit',sha:commit}}],
    ['/git/ref/tags/release/v3',{ref:'refs/tags/release/v3',object:{type:'tag',sha:tagSha}}],
    ['/git/tags/'+tagSha,{sha:tagSha,object:{type:'commit',sha:commit}}],['/git/commits/'+commit,{sha:commit,tree:{sha:tree}}]
  ]);
  const transport:typeof fetch=async(input,init)=>{const url=new URL(String(input)),path=url.pathname.replace('/repos/acme/app','')+url.search;calls.push({path,init});
    if(!routes.has(path))return new Response('private response',{status:404});const value=routes.get(path);
    if(value instanceof Error)throw value;if(value instanceof Response)return value;return Response.json(value);};
  const catalog=new GitHubReleaseCatalog({id:'github',repository:'acme/app',pageSize:2,maxPages:3,fetch:transport,...options});return{catalog,calls,routes};
}
test('GitHub catalog paginates published choices and resolves lightweight/annotated tags to exact commit and tree',async()=>{
  const f=fixture(),choices=await f.catalog.list();assert.deepEqual(choices.map(x=>x.id),['github-3','github-1']);assert.equal(f.catalog.truncated,false);
  assert.equal(choices[0]!.source.commit,undefined,'discovery is not an immutable release');
  for(const id of ['github-1','github-3']){const resolved=await f.catalog.resolve(id);assert.equal(resolved.source.commit,commit);assert.equal(resolved.source.tree,tree);assert.equal(resolved.source.repository,'https://github.com/acme/app.git');}
  assert.ok(f.calls.some(call=>call.path==='/git/tags/'+tagSha));
  assert.ok(f.calls.every(call=>call.init?.method==='GET'&&call.init.redirect==='error'));
  const count=f.calls.length;await f.catalog.resolve('github-1');assert.equal(f.calls.length,count,'same catalog selection is pinned after first resolution');
  await assert.rejects(()=>f.catalog.resolve('main'),/discovered release/);
});
test('drafts stay hidden even with authentication; prerelease and truncation are explicit',async()=>{
  const f=fixture({includePrereleases:true,maxPages:1,token:async()=>'PRIVATE-TOKEN'});assert.deepEqual((await f.catalog.list()).map(x=>x.id),['github-2','github-1']);assert.equal(f.catalog.truncated,true);
  assert.equal((f.calls[0]!.init!.headers as Record<string,string>).Authorization,'Bearer PRIVATE-TOKEN');
});
test('release substitution, malformed refs, wrong commits and annotated tag cycles fail closed',async()=>{
  for(const mismatch of ['release','ref','commit','cycle']){const f=fixture();await f.catalog.list();
    if(mismatch==='release')f.routes.set('/releases/3',release(3,'v4'));
    if(mismatch==='ref')f.routes.set('/git/ref/tags/release/v3',{ref:'refs/tags/wrong',object:{type:'commit',sha:commit}});
    if(mismatch==='commit')f.routes.set('/git/commits/'+commit,{sha:'9'.repeat(40),tree:{sha:tree}});
    if(mismatch==='cycle')f.routes.set('/git/tags/'+tagSha,{sha:tagSha,object:{type:'tag',sha:tagSha}});
    await assert.rejects(()=>f.catalog.resolve('github-3'),/changed|different|limits/);
  }
});
test('catalog rejects credential-bearing endpoint/config data and removes private HTTP errors',async()=>{
  for(const apiBase of ['http://api.github.com','https://user:password@github.example/api','https://api.github.com?token=x'])assert.throws(()=>fixture({apiBase}),/credential-free/);
  for(const repository of ['../../secrets','a/b/c','acme/..'])assert.throws(()=>fixture({repository}),/owner\/repository/);
  const f=fixture();f.routes.set('/releases?per_page=2&page=1',new Error('PRIVATE-TOKEN /private/path'));
  await assert.rejects(()=>f.catalog.list(),error=>error instanceof Error&&!/PRIVATE|private/.test(error.message)&&/could not/.test(error.message));
  const bad=fixture();bad.routes.set('/releases?per_page=2&page=1',new Response('PRIVATE-TOKEN',{status:403}));await assert.rejects(()=>bad.catalog.list(),/failed \(403\)/);
});
test('malformed and oversized responses cannot populate the source selector',async()=>{
  for(const rows of [[release(1,'../unsafe')],[release(1),release(1)],[release(1,'v1',{name:'ghp_'+'a'.repeat(30)})],{private:'not an array'}]){
    const f=fixture();f.routes.set('/releases?per_page=2&page=1',rows);await assert.rejects(()=>f.catalog.list());await assert.rejects(()=>f.catalog.resolve('github-1'),/discovered/);
  }
  const f=fixture();f.routes.set('/releases?per_page=2&page=1',new Response('x'.repeat(2*1024*1024+1)));await assert.rejects(()=>f.catalog.list(),/could not/);
});
