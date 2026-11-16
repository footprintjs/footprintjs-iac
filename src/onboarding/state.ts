import type { OnboardingAction, OnboardingSnapshot } from './types.ts';
export interface OnboardingProof {runId:string;evidencePath:string;tracePath:string;digest:string}
export interface OnboardingEntry { id:string;action:OnboardingAction;before:OnboardingSnapshot;after?:OnboardingSnapshot;proof?:OnboardingProof }
export interface OnboardingState {version:1;kind:'onboarding-state';bindingDigest:string;view:OnboardingSnapshot;entries:OnboardingEntry[]}
