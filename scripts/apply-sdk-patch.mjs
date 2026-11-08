// Experimental MIT-licensed changes to the pinned public SDK, not an upstream release.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = path.join(root, 'node_modules', '@bradygaster', 'squad-sdk');
const { version } = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
if (version !== '0.13.1') throw new Error('Experiment patch requires squad-sdk 0.13.1');
const marker = '// squad-memory-dolt-poc: experimental lifecycle patch v1\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const edits = [
  {
    file: 'memory/index.js',
    hash: '29601b2bf051bbc341a42bcb7ab832c4c01e4404e320aa6b19e57cf6efb8d12d',
    replacements: [
      [
        '        this.registeredProviders = options.registeredProviders ?? [];',
        `        this.registeredProviders = options.registeredProviders ?? [];
        if (new Set(this.registeredProviders.map(provider => provider.id)).size !== this.registeredProviders.length) {
            throw new Error('Registered memory provider ids must be unique within a store');
        }`,
      ],
      [
        '                const providerResult = await provider.write(providerWriteRequest);',
        `                const providerResult = await provider.write(providerWriteRequest);
                await this.withIndexLock(async () => {
                    const nextIndex = await this.readIndex();
                    const local = nextIndex.find(item => item.id === id);
                    if (!local) throw new Error('Local memory disappeared before replica identity was recorded');
                    local.replicas ??= [];
                    local.replicas.push({ provider: provider.id, id: providerResult.id });
                    await this.writeIndex(nextIndex);
                });`,
      ],
      [
        `        const index = await this.readIndex();
        const results = [];`,
        `        const index = await this.readIndex();
        const retiredLocalIds = new Set();
        const excludedReplicas = new Map();
        for (const entry of index) {
            const retired = entry.status !== 'active'
                || await this.storage.exists(path.join(this.squadDir, 'memory', 'tombstones', \`\${entry.id}.json\`));
            if (!retired) continue;
            retiredLocalIds.add(entry.id);
            for (const replica of entry.replicas ?? []) {
                const ids = excludedReplicas.get(replica.provider) ?? new Set();
                ids.add(replica.id);
                excludedReplicas.set(replica.provider, ids);
            }
        }
        const results = [];`,
      ],
      [
        "        for (const entry of index.filter(item => item.status === 'active')) {",
        "        for (const entry of index.filter(item => item.status === 'active' && !retiredLocalIds.has(item.id))) {",
      ],
      [
        "                .filter(item => item.status === 'active' && item.class === 'COPILOT_MEMORY')",
        "                .filter(item => item.status === 'active' && !retiredLocalIds.has(item.id) && item.class === 'COPILOT_MEMORY')",
      ],
      [
        '                for (const result of providerResults) {',
        `                for (const result of providerResults) {
                    if (excludedReplicas.get(provider.id)?.has(result.id)) continue;`,
      ],
    ],
  },
  {
    file: 'tools/index.js',
    hash: '00c4ef2d8f0f97554703d5acdef9a30ae11083031427b360812a9dae132921d6',
    replacements: [
      [
        "    constructor(squadRoot = '.squad', sessionPoolGetter, storage = new FSStorageProvider(), state, fanOutDepsGetter, hostInjectedCopilotAdapterClient) {",
        "    constructor(squadRoot = '.squad', sessionPoolGetter, storage = new FSStorageProvider(), state, fanOutDepsGetter, hostInjectedCopilotAdapterClient, registeredMemoryProviders) {",
      ],
      [
        '            hostInjectedCopilotAdapterClient,',
        `            hostInjectedCopilotAdapterClient,
            registeredProviders: registeredMemoryProviders,`,
      ],
    ],
  },
  {
    file: 'tools/index.d.ts',
    hash: '804930cbb501b6a26672773b3810d61abad1450c0e40f4c525db27dba5e80d7c',
    replacements: [
      [
        'hostInjectedCopilotAdapterClient?: CopilotMemoryProviderClient);',
        "hostInjectedCopilotAdapterClient?: CopilotMemoryProviderClient, registeredMemoryProviders?: import('../memory/index.js').MemoryProvider[]);",
      ],
    ],
  },
];

// Validate all preimages before writing any file. Re-running validates exact patched content too.
const planned = [];
for (const edit of edits) {
  const target = path.join(sdk, 'dist', ...edit.file.split('/'));
  const current = await readFile(target, 'utf8');
  let base = current;
  if (current.startsWith(marker)) {
    base = current.slice(marker.length);
    for (const [before, after] of [...edit.replacements].reverse()) {
      if (base.split(after).length !== 2) throw new Error(`Altered patched SDK file: ${edit.file}`);
      base = base.replace(after, before);
    }
  }
  if (digest(base) !== edit.hash) throw new Error(`Unexpected SDK preimage: ${edit.file}`);
  let next = base;
  for (const [before, after] of edit.replacements) {
    if (next.split(before).length !== 2) throw new Error(`Ambiguous SDK patch anchor: ${edit.file}`);
    next = next.replace(before, after);
  }
  planned.push([target, marker + next]);
}
for (const [target, content] of planned) await writeFile(target, content);
console.log('Applied experimental lifecycle guard + tool registration patch to squad-sdk 0.13.1 (3 files).');
