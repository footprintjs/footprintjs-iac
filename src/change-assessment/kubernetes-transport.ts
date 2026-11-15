import {request} from 'node:https';

export interface KubernetesAssessmentResponse{status:number;body:unknown}
export interface KubernetesAssessmentTransport{
  request(method:'GET'|'PATCH',path:string,body?:unknown,options?:{contentType?:'application/apply-patch+yaml'|'application/merge-patch+json'}):Promise<KubernetesAssessmentResponse>;
}
export interface HttpsKubernetesAssessmentOptions {
  server:string;ca:string|Buffer;cert?:string|Buffer;key?:string|Buffer;
  token?:()=>Promise<string|undefined>;timeoutMs?:number;
}
/** Host-only TLS/auth adapter. It permits GET and strictly dry-run PATCH, never persisted mutations. */
export function createHttpsKubernetesAssessmentTransport(options:HttpsKubernetesAssessmentOptions):KubernetesAssessmentTransport{
  const server=new URL(options.server),timeout=options.timeoutMs??10000;
  if(server.protocol!=='https:'||server.username||server.password||server.search||server.hash||server.pathname!=='/'||!options.ca
    ||!Number.isSafeInteger(timeout)||timeout<1||timeout>60000||!!options.cert!==!!options.key)throw Error('Configure a verified HTTPS Kubernetes API');
  const fixed={server:server.origin,ca:Buffer.from(options.ca),cert:options.cert?Buffer.from(options.cert):undefined,key:options.key?Buffer.from(options.key):undefined,token:options.token};
  return{async request(method,path,body,settings){
    const url=new URL(path,fixed.server);
    const dns='[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?',allowed=new RegExp('^(?:/api/v1/namespaces/'+dns+'(?:/(?:configmaps|services)/'+dns+')?|/apis/apps/v1/namespaces/'+dns+'/deployments/'+dns+')$');
    if(!path.startsWith('/')||path.startsWith('//')||url.origin!==fixed.server||!allowed.test(url.pathname)||url.hash||!['GET','PATCH'].includes(method)
      ||settings?.contentType!==undefined&&!['application/apply-patch+yaml','application/merge-patch+json'].includes(settings.contentType)
      ||method==='GET'&&url.search||method==='PATCH'&&(url.searchParams.get('dryRun')!=='All'||[...url.searchParams.keys()].some(key=>!['dryRun','fieldManager','fieldValidation','force'].includes(key))
        ||url.searchParams.has('force')&&(url.searchParams.get('force')!=='true'||settings?.contentType!=='application/apply-patch+yaml')
        ||[...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1)))throw Error('Only read-only Kubernetes assessment requests are permitted');
    try{
      const token=await fixed.token?.();if(token&&(/[\r\n]/.test(token)||token.length>8192))throw Error('Invalid token');
      const payload=body===undefined?undefined:JSON.stringify(body);if(payload&&Buffer.byteLength(payload)>2*1024*1024)throw Error('Bound Kubernetes dry-run payload');
      return await new Promise<KubernetesAssessmentResponse>((resolve,reject)=>{
        const req=request(url,{method,ca:fixed.ca,cert:fixed.cert,key:fixed.key,rejectUnauthorized:true,signal:AbortSignal.timeout(timeout),headers:{Accept:'application/json',...(method==='PATCH'?{'Content-Type':settings?.contentType??'application/apply-patch+yaml'}:{}),...(token?{Authorization:'Bearer '+token}:{})}},response=>{
          const chunks:Buffer[]=[];let bytes=0;response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024){response.destroy();req.destroy(Error('Response limit'));return;}chunks.push(chunk);});
          response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('Malformed API response'));}});
        });
        req.setTimeout(timeout,()=>req.destroy(Error('API deadline')));req.on('error',reject);req.end(payload);
      });
    }catch{throw Error('Kubernetes assessment request could not be completed');}
  }};
}
