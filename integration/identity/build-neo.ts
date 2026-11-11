import { buildNeoImages } from './build-neo-images.ts';

const args = process.argv.slice(2);
const stageOnly = args.includes('--stage-only');
const positional = args.filter(arg => arg !== '--stage-only');
if (args.filter(arg => arg === '--stage-only').length > 1 || positional.some(arg => arg.startsWith('--'))
  || positional.length < 2 || positional.length > 3 || !/^[a-f0-9]{40}$/.test(positional[1] ?? '')) {
  throw new Error('Usage: node integration/identity/build-neo.ts [--stage-only] /path/to/Neo REVIEWED_INDEX_TREE [/path/to/target.json]');
}
console.log(JSON.stringify(await buildNeoImages(positional[0]!, positional[1]!, positional[2], { stageOnly }), null, 2));
