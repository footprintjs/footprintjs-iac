import {ScopeFacade,type ScopeFactory} from 'footprintjs/advanced';
export class OnboardingVersionScope extends ScopeFacade{}
export const onboardingVersionScopeFactory:ScopeFactory<OnboardingVersionScope>=(context,name,readOnly,environment)=>new OnboardingVersionScope(context,name,readOnly,environment);
