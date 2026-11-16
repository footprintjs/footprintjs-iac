import { canonical, fingerprint } from '../util.ts';
import type { ProviderContext, Resource, ResourceAdapter } from '../types.ts';
import { factsDigest, readSystemdObservation } from './data.ts';
import { admitSystemdOutcomeProof } from './outcome-proof.ts';
import type { SystemdDeploymentHost, SystemdDeploymentOptions, SystemdHostObservation, SystemdUnitObservation } from './types.ts';

/** Systemd provider semantics over fixed private host recipes. No unit or host creation/removal. */
export class SystemdResourceAdapter implements ResourceAdapter {
  readonly name = 'systemd'; readonly supportsSafeRetry = false; readonly scope: string;
  private readonly host: SystemdDeploymentHost;
  private groupPermit:SystemdHostObservation|undefined;
  private readonly permits = new Map<string,SystemdUnitObservation>();
  private readonly mode:'group'|'independent';
  private readonly registration:SystemdDeploymentOptions['registration'];
  private readonly units:SystemdDeploymentOptions['units'];
  private outcomeFacts:SystemdHostObservation|undefined;
  constructor(registration:SystemdDeploymentOptions['registration'], units:SystemdDeploymentOptions['units'], host:SystemdDeploymentHost, privateMode:'group'|'independent'='group') {
    this.registration=registration;this.units=units;this.mode=privateMode;
    this.scope = `systemd-pinned:${fingerprint(registration)}`;
    this.host = { inspect:host.inspect.bind(host), ...(host.applyUnit?{applyUnit:host.applyUnit.bind(host)}:{}), ...(host.applyUnits?{applyUnits:host.applyUnits.bind(host)}:{}),
      ...(host.reconcileUnit?{reconcileUnit:host.reconcileUnit.bind(host)}:{}),...(host.reconcileUnits?{reconcileUnits:host.reconcileUnits.bind(host)}:{}) };
  }
  async inspect(): Promise<SystemdHostObservation> {
    let observed: SystemdHostObservation;
    try { observed = readSystemdObservation(await this.host.inspect()); } catch { throw Error('systemd-observation-unavailable'); }
    if (observed.identityDigest !== this.registration.identityDigest || observed.units.length !== this.units.length) throw Error('systemd-host-identity-mismatch');
    for (const unit of this.units) {
      const actual = observed.units.find(item => item.name === unit.name);
      if (!actual?.exists || actual.fragmentPath !== unit.fragmentPath || actual.configurationDigest !== unit.configurationDigest || !actual.fragmentDigest) throw Error('systemd-unit-binding-mismatch');
    }
    return observed;
  }
  permit(facts: SystemdHostObservation): void { this.groupPermit=structuredClone(facts);this.permits.clear(); for (const unit of facts.units) this.permits.set(unit.name,structuredClone(unit)); }
  prepareOutcome(facts:SystemdHostObservation):void { this.outcomeFacts=structuredClone(facts); }
  async inspectOutcome(resource:Resource,context:ProviderContext) {
    const original=this.outcomeFacts;if(!original)throw Error('systemd-original-outcome-context-required');
    const desiredSpecDigest=fingerprint(resource.spec),releaseDigest=String(resource.spec.releaseDigest);
    let inspection;
    if(this.mode==='group'){
      this.group(resource);if(!this.host.reconcileUnits)throw Error('systemd-outcome-inspector-not-registered');
      inspection=await this.host.reconcileUnits({units:this.units.map(unit=>unit.name),desiredSpecDigest,releaseDigest},
        {operationId:context.operationId,expectedIdentityDigest:this.registration.identityDigest,expectedUnits:structuredClone(original.units)});
    }else{
      const binding=this.binding(resource),expectedUnit=original.units.find(unit=>unit.name===binding.name);
      if(!this.host.reconcileUnit||!expectedUnit)throw Error('systemd-outcome-inspector-not-registered');
      inspection=await this.host.reconcileUnit({unit:binding.name,desiredSpecDigest,releaseDigest},
        {operationId:context.operationId,expectedIdentityDigest:this.registration.identityDigest,expectedUnit:structuredClone(expectedUnit)});
    }
    await admitSystemdOutcomeProof(inspection.proof,context.operationId);
    const facts=await this.inspect(),names=this.mode==='group'?this.units.map(unit=>unit.name):[this.binding(resource).name];
    if(!Array.isArray(inspection.jobs)||inspection.jobs.length!==names.length||new Set(inspection.jobs.map(job=>job.unit)).size!==names.length
      ||inspection.jobs.some(job=>!names.includes(job.unit)||job.jobId!==null&&(typeof job.jobId!=='string'||!/^\d{1,20}$/.test(job.jobId))))throw Error('systemd-manager-jobs-not-observed');
    const affected=facts.units.filter(unit=>names.includes(unit.name));
    const quiescent=inspection.jobs.every(job=>job.jobId===null)&&affected.every(unit=>['active','inactive','failed'].includes(unit.activeState))
      &&affected.some(unit=>['inactive','failed'].includes(unit.activeState));
    const observation=this.observation(resource,facts);
    return {runtimeControlReturned:inspection.runtimeControlReturned===true,quiescent,observation,
      evidence:JSON.parse(JSON.stringify({proof:inspection.proof,jobs:inspection.jobs,facts,originalFactsDigest:factsDigest(original)}))};
  }
  private binding(resource: Resource) {
    const unit = this.units.find(item=>item.id===resource.id);
    if (!unit || resource.provider!=='systemd' || resource.spec.kind!=='SystemdService' || resource.spec.name!==unit.name
      || resource.spec.configurationDigest!==unit.configurationDigest || Object.keys(resource.spec).sort().join(',')!=='configurationDigest,kind,name,releaseDigest') throw Error('systemd-resource-not-registered');
    return unit;
  }
  private group(resource:Resource):void {
    if(this.mode!=='group'||resource.id!=='systemd-services'||resource.provider!=='systemd'||resource.spec.kind!=='SystemdServiceGroup'
      ||canonical(resource.spec.units)!==canonical(this.units.map(({id,name,configurationDigest})=>({id,name,configurationDigest})))
      ||Object.keys(resource.spec).sort().join(',')!=='kind,releaseDigest,units')throw Error('systemd-group-not-registered');
  }
  async observe(resource: Resource) {
    return this.observation(resource,await this.inspect());
  }
  private observation(resource:Resource,facts:SystemdHostObservation){
    if(this.mode==='group'){
      this.group(resource);const ready=facts.units.every(unit=>unit.activeState==='active');
      const applied=facts.units[0]?.appliedSpecDigest;
      return{exists:true,owned:true,ready,physicalId:`systemd-group://${fingerprint({scope:this.scope,units:this.units.map(unit=>({name:unit.name,path:unit.fragmentPath}))})}`,
        ...(ready&&applied&&facts.units.every(unit=>unit.appliedSpecDigest===applied)?{fingerprint:applied}:{})};
    }
    const unit = this.binding(resource), actual = facts.units.find(item=>item.name===unit.name)!;
    return { exists:true,owned:true,ready:actual.activeState==='active',
      physicalId:`systemd-pinned://${fingerprint({scope:this.scope,name:unit.name,path:unit.fragmentPath})}`,
      ...(actual.activeState==='active' && actual.appliedSpecDigest ? {fingerprint:actual.appliedSpecDigest} : {}) };
  }
  async apply(resource: Resource, context: ProviderContext): Promise<void> {
    if(this.mode==='group'){
      this.group(resource);const before=await this.inspect(),permit=this.groupPermit;
      if(!permit||factsDigest(before)!==factsDigest(permit)||!this.host.applyUnits)throw Error('systemd-group-changed-after-review');
      this.groupPermit=undefined;
      try{await this.host.applyUnits({units:this.units.map(unit=>unit.name),desiredSpecDigest:fingerprint(resource.spec),releaseDigest:String(resource.spec.releaseDigest)},
        {operationId:context.operationId,expectedIdentityDigest:this.registration.identityDigest,expectedUnits:structuredClone(before.units)});}
      catch{throw Error('systemd-effect-unconfirmed');}return;
    }
    const unit=this.binding(resource), before=(await this.inspect()).units.find(item=>item.name===unit.name)!, permit=this.permits.get(unit.name);
    if (!permit || canonical(before)!==canonical(permit)) throw Error('systemd-unit-changed-after-review');
    this.permits.delete(unit.name); // A provider call cannot be repeated by this permit.
    try { await this.host.applyUnit!({unit:unit.name,desiredSpecDigest:fingerprint(resource.spec),releaseDigest:String(resource.spec.releaseDigest)},
      {operationId:context.operationId,expectedIdentityDigest:this.registration.identityDigest,expectedUnit:structuredClone(before)}); }
    catch { throw Error('systemd-effect-unconfirmed'); }
  }
  async waitReady(resource: Resource): Promise<void> {
    const observed=await this.observe(resource);
    if (!observed.ready || observed.fingerprint!==fingerprint(resource.spec)) throw Error('systemd-service-not-converged');
  }
  async remove(): Promise<never> { throw Error('systemd-service-removal-not-admitted'); }
}
