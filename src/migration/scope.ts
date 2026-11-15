import { ScopeFacade,type ScopeFactory } from 'footprintjs/advanced';
export class MigrationScope extends ScopeFacade {}
export const migrationScopeFactory:ScopeFactory<MigrationScope>=(context,name,readOnly,environment)=>new MigrationScope(context,name,readOnly,environment);
