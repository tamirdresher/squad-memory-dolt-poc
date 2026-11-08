import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'PUBLICATION.json'), 'utf8'));
const allowed = new Set(manifest.publishOnly);
const found = new Set();
async function walk(relative = '') {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && manifest.exclude.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not publication artifacts: ${name}`);
    if (entry.isDirectory()) await walk(name);
    else {
      if (!allowed.has(name)) throw new Error(`Unexpected file outside publication allowlist: ${name}`);
      found.add(name);
    }
  }
}
await walk();
let bytes = 0;
for (const name of manifest.publishOnly) {
  if (!found.has(name)) throw new Error(`Missing publication file: ${name}`);
  const buffer = await readFile(path.join(root, ...name.split('/')));
  const text = buffer.toString('utf8');
  const forbidden = [
    /[A-Za-z]:[\\/]Users[\\/]/i,
    /[\\/](?:Users|home)[\\/][^\\/\s]+[\\/]/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:_authToken|_password|_auth)\s*=/i,
  ];
  if (buffer.includes(0) || forbidden.some(pattern => pattern.test(text))) {
    throw new Error(`Binary, machine path, or credential-like content: ${name}`);
  }
  bytes += buffer.length;
  console.log(`${createHash('sha256').update(buffer).digest('hex')}  ${name}`);
}
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (lock.packages['node_modules/@bradygaster/squad-sdk'].version !== '0.13.1') {
  throw new Error('Public SDK pin changed');
}
for (const entry of Object.values(lock.packages)) {
  if (entry.resolved && !entry.resolved.startsWith('https://packagefeedproxy.microsoft.io/npm/')) {
    throw new Error('Lockfile archive outside CFS registry');
  }
}
console.log(`AUDIT PASSED: ${found.size} allowlisted text files, ${bytes} bytes. Excluded dependency/scratch directories are not publication artifacts.`);
