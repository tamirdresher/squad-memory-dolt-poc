import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'node_modules', '@bradygaster', 'squad-sdk', 'dist', 'memory', 'index.js');
const original = await readFile(target, 'utf8');
const guard = '                    if (excludedReplicas.get(provider.id)?.has(result.id)) continue;';
if (original.split(guard).length !== 2) throw new Error('Expected exactly one experimental exclusion guard');
try {
  await writeFile(target, original.replace(guard, '                    // Deliberate mutation: allow retired replicas.'));
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run', '--config', 'vitest.config.ts', 'memory-lifecycle-exclusion.test.ts',
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 1 || !output.includes('old-key') || !output.includes('AssertionError')) {
    throw new Error(`Mutation did not produce the expected retired-replica assertion failure:\n${output}`);
  }
  console.log('RED CONFIRMED: removing SDK exact-replica rejection fails lifecycle assertions (synthetic provider, not real-engine proof).');
} finally {
  await writeFile(target, original);
}
if (await readFile(target, 'utf8') !== original) throw new Error('SDK restoration failed');
console.log('RESTORED: original patched SDK bytes.');
