/** Explicit local consumer fixture; not a general Kubernetes application profile. */
export { createNeoSystem } from './system.ts';
export { neoKubernetesProfile, type NeoKubernetesOptions } from './kubernetes-profile.ts';
export { NEO_NAMESPACE } from './stack.ts';
