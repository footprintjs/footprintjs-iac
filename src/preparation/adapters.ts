import type {DeliveryAdapters,DeliveryBuild,DeliveryPublication} from '../delivery/types.ts';

export type PreparationAdapters=Pick<DeliveryAdapters,'source'|'build'|'artifacts'>;
interface AdapterPolicies {
 error:string;
 build?(input:unknown):DeliveryBuild;
 publication?(input:unknown):DeliveryPublication;
}
/** Capture each registered method once; later caller mutation cannot replace it. */
export function capturePreparationAdapters(input:PreparationAdapters,policies:AdapterPolicies):PreparationAdapters{
 const resolve=input?.source?.resolve,fetch=input?.source?.fetch,build=input?.build?.build,publish=input?.artifacts?.publish;
 if(typeof resolve!=='function'||typeof fetch!=='function'||typeof build!=='function'||typeof publish!=='function')throw Error(policies.error);
 const buildBound=build.bind(input.build),publishBound=publish.bind(input.artifacts),readBuild=policies.build,readPublication=policies.publication;
 return Object.freeze({
  source:Object.freeze({resolve:resolve.bind(input.source),fetch:fetch.bind(input.source)}),
  build:Object.freeze({build:readBuild?async(...args:Parameters<typeof build>)=>readBuild(await buildBound(...args)):buildBound}),
  artifacts:Object.freeze({publish:readPublication?async(...args:Parameters<typeof publish>)=>readPublication(await publishBound(...args)):publishBound}),
 });
}
