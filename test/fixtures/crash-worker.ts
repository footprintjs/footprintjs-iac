import { join } from 'node:path';
import { InfraEngine } from '../../src/engine.ts';
import { FileStateStore } from '../../src/store.ts';
import { SimulatorAdapter } from '../../src/providers/simulator.ts';
import type { Stack } from '../../src/types.ts';

const directory = process.argv[2];
if (!directory) throw new Error('A scratch directory is required');

const stack: Stack = {
  name: 'crash-recovery',
  resources: [{ id: 'worker', provider: 'simulator', spec: { image: 'worker:v1', replicas: 1 } }],
};
const adapter = new SimulatorAdapter({
  file: join(directory, 'provider.json'),
  faults: {
    afterEffect: async () => {
      // The remote effect has landed, but apply has not returned to the engine.
      process.stdout.write('provider-effect-persisted\n');
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    },
  },
});
const result = await new InfraEngine({ adapters: [adapter], store: new FileStateStore(join(directory, 'state')) }).apply(stack);
throw new Error(`Engine unexpectedly returned before the provider fault: ${JSON.stringify(result)}`);
