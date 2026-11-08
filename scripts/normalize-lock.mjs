// CFS metadata can resolve through a public mirror redirect. Keep the lock on CFS.
import { readFile, writeFile } from 'node:fs/promises';
const lockPath = new URL('../package-lock.json', import.meta.url);
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
for (const entry of Object.values(lock.packages)) {
  if (!entry.resolved) continue;
  const url = new URL(entry.resolved);
  const prefix = '/1es-public/_packaging/npm-public/npm/registry/';
  if (/^ms-feed-\d+\.pkgs\.visualstudio\.com$/.test(url.hostname) && url.pathname.startsWith(prefix)) {
    entry.resolved = `https://packagefeedproxy.microsoft.io/npm/${url.pathname.slice(prefix.length)}`;
  }
  if (!entry.resolved.startsWith('https://packagefeedproxy.microsoft.io/npm/')) {
    throw new Error('Unexpected archive registry; review before publication');
  }
}
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log('Normalized public archive URLs to CFS; versions and integrity pins preserved.');
