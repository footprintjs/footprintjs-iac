import { defineAccessPolicy } from '../../src/identity/index.ts';

export function neoAccessPolicy() {
  return defineAccessPolicy({ id: 'neo-local-access', rules: [{
    id: 'readers-can-chat', effect: 'allow', source: 'neo-directory', groups: ['neo-readers'],
    actions: ['neo:chat'], resources: ['neo'],
  }] });
}
