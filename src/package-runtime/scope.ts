import {ScopeFacade,type ScopeFactory} from 'footprintjs/advanced';
export class PackageScope extends ScopeFacade{}
export const packageScopeFactory:ScopeFactory<PackageScope>=(context,name,readOnly,environment)=>new PackageScope(context,name,readOnly,environment);
