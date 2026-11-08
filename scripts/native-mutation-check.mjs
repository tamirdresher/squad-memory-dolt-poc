import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.SQUAD_NATIVE_REPO_ROOT;
if (!repo) throw new Error('Set SQUAD_NATIVE_REPO_ROOT to the modified local Squad source checkout');
const artifact = path.join(repo, 'packages', 'squad-sdk', 'dist', 'memory', 'discovery.js');
const original = await readFile(artifact);
const before = 'return discovered;';
const source = original.toString('utf8');
assert.equal(source.split(before).length, 2, 'Expected exact native registration gate once');
const directory = path.join(sample, '.scratch', `native-mutation-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const config = path.join(directory, 'vitest.config.mjs');
await writeFile(config, `export default ${JSON.stringify({
  root: repo, resolve: { alias: { vitest: path.join(sample, 'node_modules', 'vitest', 'dist', 'index.js') } },
  test: { fileParallelism: false, testTimeout: 60_000 },
})};`);
const args = [path.join(sample, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config,
  'test/memory-provider-discovery.test.ts', '-t', 'stock state MCP writes use native discovery', '--reporter', 'verbose'];
function run() {
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
}
assert.equal(run().status, 0, 'Native stock-MCP contract must pass before mutation');
try {
  await writeFile(artifact, source.replace(before, 'return [];'));
  const result = run();
  await writeFile(path.join(directory, 'mutation-output.txt'), result.stdout + result.stderr);
  assert.notEqual(result.status, 0, 'Bypassing real emitted factory registration must fail');
  assert.match(result.stdout + result.stderr, /replicas\.json|ENOENT/, 'Failure must identify missing native provider output');
} finally {
  await writeFile(artifact, original);
}
assert.deepEqual(await readFile(artifact), original, 'Restore emitted artifact byte-for-byte');
assert.equal(run().status, 0, 'Native stock-MCP contract must pass after restoration');
console.log('PASS: emitted native registration bypass fails the stock MCP output contract; bytes restored.');
