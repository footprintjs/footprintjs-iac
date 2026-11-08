import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createNeoStack } from './stack.ts';

const destination = resolve(process.argv[2] ?? '.artifacts/neo/stack.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(createNeoStack(), null, 2) + '\n');
console.log(destination);
