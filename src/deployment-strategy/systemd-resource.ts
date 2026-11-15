import { canonical, fingerprint } from '../util.ts';
import type { ProviderContext, Resource, ResourceAdapter } from '../types.ts';
import { factsDigest, readSystemdObservation } from './data.ts';
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
  constructor(registration:SystemdDeploymentOptions['registration'], units:SystemdDeploymentOptions['units'], host:SystemdDeploymentHost, privateMode:'group'|'independent'='group') {
    this.registration=registration;this.units=units;this.mode=privateMode;
    this.scope = `systemd-pinned:${fingerprint(registration)}`;
    this.host = { inspect:host.inspect.bind(host), ...(host.applyUnit?{applyUnit:host.applyUnit.bind(host)}:{}), ...(host.applyUnits?{applyUnits:host.applyUnits.bind(host)}:{}) };
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
    if(this.mode==='group'){
      this.group(resource);const facts=await this.inspect(),ready=facts.units.every(unit=>unit.activeState==='active');
      const applied=facts.units[0]?.appliedSpecDigest;
      return{exists:true,owned:true,ready,physicalId:`systemd-group://${fingerprint({scope:this.scope,units:this.units.map(unit=>({name:unit.name,path:unit.fragmentPath}))})}`,
        ...(ready&&applied&&facts.units.every(unit=>unit.appliedSpecDigest===applied)?{fingerprint:applied}:{})};
    }
    const unit = this.binding(resource), facts = await this.inspect(), actual = facts.units.find(item=>item.name===unit.name)!;
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
