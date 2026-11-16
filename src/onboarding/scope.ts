import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class OnboardingScope extends ScopeFacade {}
export const onboardingScopeFactory: ScopeFactory<OnboardingScope> = (context, name, readOnly, environment) => new OnboardingScope(context, name, readOnly, environment);
