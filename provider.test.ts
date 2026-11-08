import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  LocalMemoryStore,
  type CopilotMemoryProviderWriteRequest,
  type MemoryProvider,
  type MemoryProviderSearchResult,
} from '@bradygaster/squad-sdk/memory';
import { InMemoryStorageProvider, FSStorageProvider } from '@bradygaster/squad-sdk/storage';
import { ToolRegistry } from '@bradygaster/squad-sdk/tools';
import { compileCharterFull } from '@bradygaster/squad-sdk/agents';
import { DoltCli, DoltMemoryProvider, literal, object, text } from './provider.js';

const sampleRoot = path.dirname(fileURLToPath(import.meta.url));
const project = 'synthetic-project';
const reviewer = 'synthetic-reviewer';
const classifyStore = new LocalMemoryStore(new InMemoryStorageProvider(), sampleRoot);
let runRoot: string | undefined;
let a: DoltMemoryProvider;
let b: DoltMemoryProvider;
let remoteUrl: string;

async function fixture(id: string, content = `Synthetic knowledge ${id}`, scope = project): Promise<CopilotMemoryProviderWriteRequest> {
  return {
    title: `Fixture ${id}`,
    content,
    author: 'synthetic-author',
    metadata: { project: scope, memoryId: id, source: 'synthetic-fixture', provenance: 'review-session-1' },
    classification: await classifyStore.classify({ content, requestedClass: 'LOCAL' }),
  };
}

function sdk(provider: MemoryProvider, storage = new InMemoryStorageProvider()): LocalMemoryStore {
  return new LocalMemoryStore(storage, sampleRoot, { registeredProviders: [provider] });
}

async function accept(provider: DoltMemoryProvider, id: string): Promise<void> {
  const record = await provider.inspect(id);
  expect(record, `reviewable payload ${id}`).toBeDefined();
  if (!record) throw new Error('Missing fixture');
  await provider.accept(id, record.fingerprint, reviewer);
}

async function accepted(provider: DoltMemoryProvider, id: string, content?: string): Promise<void> {
  await provider.write(await fixture(id, content, provider.scope));
  await accept(provider, id);
}

beforeAll(async () => {
  const probe = new DoltCli(sampleRoot);
  try {
    console.log(`ENGINE ${(await probe.run('version')).trim()}`);
  } catch (error) {
    throw new Error('Real integration requires Dolt: set DOLT_BIN to an official portable dolt executable. No mock/skip fallback.', { cause: error });
  }
  const scratch = process.env.DOLT_POC_SCRATCH ?? path.join(sampleRoot, '.scratch');
  await mkdir(scratch, { recursive: true });
  runRoot = await mkdtemp(path.join(scratch, 'run-'));
  const seedPath = path.join(runRoot, 'seed');
  const remotePath = path.join(runRoot, 'remote');
  await mkdir(seedPath);
  await mkdir(remotePath);
  const seed = new DoltCli(seedPath);
  await seed.run('init', '--name', 'Synthetic Reviewer', '--email', 'reviewer@example.invalid', '-b', 'main');
  await new DoltMemoryProvider(seed, project).initialize();
  await seed.checkpoint('Synthetic memory schema');
  remoteUrl = pathToFileURL(remotePath).href;
  await seed.run('remote', 'add', 'origin', remoteUrl);
  await seed.run('push', '--set-upstream', 'origin', 'main');
  const rootCli = new DoltCli(runRoot);
  await rootCli.run('clone', remoteUrl, 'clone-a');
  await rootCli.run('clone', remoteUrl, 'clone-b');
  a = new DoltMemoryProvider(new DoltCli(path.join(runRoot, 'clone-a')), project);
  b = new DoltMemoryProvider(new DoltCli(path.join(runRoot, 'clone-b')), project);
  for (const provider of [a, b]) {
    await provider.cli.run('config', '--local', '--add', 'user.name', 'Synthetic Reviewer');
    await provider.cli.run('config', '--local', '--add', 'user.email', 'reviewer@example.invalid');
  }
  await rm(seedPath, { recursive: true });
});

afterAll(async () => {
  if (!runRoot) return;
  if (process.env.DOLT_POC_KEEP === '1') console.log(`RETAINED ${path.relative(sampleRoot, runRoot)}`);
  else await rm(runRoot, { recursive: true });
});

describe.sequential('real Dolt MemoryProvider and local team sharing', () => {
  test('SDK registration/write/search, proposal gating, restart, retry and exact scope', async () => {
    const request = await fixture('sdk-seam', 'Synthetic café \\' + "'; DROP TABLE memories; -- %_[]");
    const storage = new InMemoryStorageProvider();
    const writer = sdk(a, storage);
    const result = await writer.write({
      ...request, requestedClass: 'LOCAL',
    });
    expect(result.stored).toBe(true);
    expect(result.id).not.toBe('sdk-seam'); // SDK and provider identifiers are distinct.
    const proposal = await a.inspect('sdk-seam');
    expect(proposal?.status).toBe('proposed');
    expect(proposal?.request).toEqual(request);
    expect(await a.search('café')).toEqual([]);
    // approved=true is not forwarded as authority by the generic provider seam.
    await writer.write({ content: 'Synthetic not yet reviewed', requestedClass: 'LOCAL',
      approved: true, metadata: { project, memoryId: 'approved-flag' } });
    expect((await a.inspect('approved-flag'))?.status).toBe('proposed');
    await accept(a, 'sdk-seam');
    const restarted = new DoltMemoryProvider(new DoltCli(a.cli.directory), project);
    expect(await restarted.status()).toMatchObject({ available: true, id: 'dolt-poc' });
    expect(await restarted.search('café')).toEqual([{
      id: 'sdk-seam', title: request.title, snippet: request.content, class: 'LOCAL',
      loadGuidance: 'ON-DEMAND', path: `dolt-poc:${project}:sdk-seam`,
    }]);
    // Empty local SDK storage proves retrieval actually comes through registered provider.
    expect(await sdk(restarted).search('café')).toEqual([
      expect.objectContaining({ id: 'sdk-seam', provider: 'dolt-poc', snippet: request.content }),
    ]);
    await restarted.write({ ...request, metadata: {
      provenance: 'review-session-1', source: 'synthetic-fixture', memoryId: 'sdk-seam', project,
    } });
    expect((await restarted.inspect('sdk-seam'))?.fingerprint).toBe(proposal?.fingerprint);
    expect((await restarted.inspect('sdk-seam'))?.status).toBe('accepted');
    const other = new DoltMemoryProvider(a.cli, 'other-project');
    await accepted(other, 'sdk-seam', 'Synthetic other project');
    expect(await other.search('café')).toEqual([]);
    expect(await restarted.search('other project')).toEqual([]);
    await expect(a.write(await fixture('bad-scope', 'Synthetic mismatch', 'other-project'))).rejects.toThrow('scope');
    await expect(a.write({ ...request, metadata: { memoryId: 'unscoped' } })).rejects.toThrow('scope');
    await expect(a.write({ ...request, classification: { ...request.classification, allowed: false } })).rejects.toThrow('classification');
    const forbidden = await writer.write({ content: 'Synthetic rejected fixture', requestedClass: 'FORBIDDEN',
      metadata: { project, memoryId: 'forbidden' } });
    const transient = await writer.write({ content: 'Synthetic transient fixture', requestedClass: 'TRANSIENT',
      metadata: { project, memoryId: 'transient' } });
    expect(forbidden.stored).toBe(false);
    expect(transient.stored).toBe(false);
    expect(await a.inspect('forbidden')).toBeUndefined();
    expect(await a.inspect('transient')).toBeUndefined();
    const parallel = await Promise.all([fixture('serialized-a'), fixture('serialized-b')]);
    await Promise.all(parallel.map(item => a.write(item)));
    expect((await a.inspect('serialized-a'))?.request.content).toBe('Synthetic knowledge serialized-a');
    expect((await a.inspect('serialized-b'))?.request.content).toBe('Synthetic knowledge serialized-b');
    // A provider error is audited, but does not roll back the SDK's local write.
    expect((await writer.write({ content: 'Synthetic missing scope', requestedClass: 'LOCAL' })).stored).toBe(true);
    expect(await storage.read(path.join(sampleRoot, '.squad', 'memory', 'audit.jsonl')))
      .toContain('"action":"provider-error"');
    console.log('SDK: real replication + federated search; restart preserved payload/provenance; exact scope isolated');
  });

  test('separates current retrieval from proposals, changed approvals, archive and historical payloads', async () => {
    await accepted(a, 'changed', 'Synthetic original reviewed text');
    const old = await a.inspect('changed');
    await a.write(await fixture('changed', 'Synthetic unreviewed change'));
    expect((await a.inspect('changed'))?.status).toBe('proposed');
    expect(await a.search('unreviewed change')).toEqual([]);
    await expect(a.accept('changed', old?.fingerprint ?? '', reviewer)).rejects.toThrow('Stale');
    await accept(a, 'changed');
    const archived = await fixture('archive');
    archived.classification.loadGuidance = 'ARCHIVE';
    await a.write(archived);
    await accept(a, 'archive');
    expect((await a.inspect('archive'))?.status).toBe('accepted');
    expect(await a.search('Synthetic knowledge archive')).toEqual([]);
    const never = await fixture('never-policy', 'Synthetic policy excluded from context');
    never.classification = await classifyStore.classify({
      content: never.content, requestedClass: 'POLICY', metadata: { loadGuidance: 'NEVER' },
    });
    await a.write(never);
    await accept(a, 'never-policy');
    expect((await a.inspect('never-policy'))?.request.classification).toMatchObject({ class: 'POLICY', loadGuidance: 'NEVER' });
    expect(await a.search('policy excluded')).toEqual([]);
    await accepted(a, 'forgotten', 'Synthetic forgotten historical payload');
    await accepted(a, 'prior', 'Synthetic superseded historical payload');
    await accepted(a, 'successor', 'Synthetic replacement accepted payload');
    await a.cli.checkpoint('Accepted seed fixtures before sharing');
    await a.cli.push();
    await b.cli.pull();
    expect((await b.inspect('forgotten'))?.status).toBe('accepted');
    expect((await b.inspect('prior'))?.request.content).toBe('Synthetic superseded historical payload');
    expect((await b.inspect('successor'))?.acceptedBy).toBe(reviewer);
  });

  test('two independent clone additions merge and require explicit acceptance', async () => {
    await a.write(await fixture('from-a', 'Synthetic addition from clone A'));
    await a.cli.checkpoint('A proposes independent memory');
    await a.cli.push();
    await b.write(await fixture('from-b', 'Synthetic addition from clone B'));
    await b.cli.checkpoint('B proposes independent memory');
    // Non-fast-forward push is surfaced rather than overwriting remote state.
    await expect(b.cli.push()).rejects.toThrow('Dolt push failed');
    await b.cli.pull();
    expect((await b.inspect('from-a'))?.status).toBe('proposed');
    expect((await b.inspect('from-b'))?.status).toBe('proposed');
    expect(await b.search('Synthetic addition')).toEqual([]);
    await accept(b, 'from-a');
    await accept(b, 'from-b');
    await b.cli.checkpoint('Reviewer accepts exact independent payloads');
    await b.cli.push();
    await a.cli.pull();
    expect((await a.search('Synthetic addition')).map(r => [r.id, r.snippet])).toEqual([
      ['from-a', 'Synthetic addition from clone A'], ['from-b', 'Synthetic addition from clone B'],
    ]);
    console.log('SHARING: separate file:// Dolt remote; independent proposals merged, not auto-approved; both accepted payloads converged');
  });

  test('stale clone actually rewrites old keys; durable retirement prevents resurrection after sync', async () => {
    expect(await a.delete('forgotten')).toBe(true);
    expect(await a.retire('prior', 'superseded', reviewer, 'successor')).toBe(true);
    await a.cli.checkpoint('Forget one memory and supersede another');
    await a.cli.push();
    // B has not pulled retirements: demonstrate real offline stale retrieval and writes.
    expect((await b.search('forgotten historical')).map(r => r.id)).toEqual(['forgotten']);
    await accepted(b, 'forgotten', 'Synthetic stale rewrite forgotten');
    await accepted(b, 'prior', 'Synthetic stale rewrite superseded');
    expect((await b.search('Synthetic stale rewrite')).map(r => r.id)).toEqual(['forgotten', 'prior']);
    await b.cli.checkpoint('Offline stale clone rewrites and accepts old keys');
    await b.cli.pull();
    expect(await b.search('Synthetic stale rewrite')).toEqual([]);
    expect((await b.inspect('forgotten'))?.status).toBe('deleted');
    expect((await b.inspect('prior'))?.status).toBe('superseded');
    await expect(b.write(await fixture('forgotten'))).rejects.toThrow('permanently retired');
    expect(await b.delete('forgotten')).toBe(false);
    expect(await b.search('replacement accepted')).toEqual([
      expect.objectContaining({ id: 'successor', snippet: 'Synthetic replacement accepted payload' }),
    ]);
    await b.cli.checkpoint('Persist merged retirements without revival');
    await b.cli.push();
    await a.cli.pull();
    expect(await a.search('Synthetic stale rewrite')).toEqual([]);
    expect((await a.inspect('forgotten'))?.request.content).toBe('Synthetic stale rewrite forgotten');
    const history = await a.cli.rows(`SELECT payload FROM dolt_history_memories
      WHERE scope=${literal(project)} AND id=${literal('forgotten')}`);
    expect(history.some(row => text(row, 'payload').includes('Synthetic forgotten historical payload'))).toBe(true);
    console.log('RETIREMENT: stale clone wrote+accepted BOTH old keys; merge retained deleted/superseded tombstones; no current retrieval; history still contains original payload');
  });

  test('SDK exclusion is independent of sample-managed provider retirement', async () => {
    const writer = sdk(a);
    const request = await fixture('sdk-delete-gap', 'Synthetic sdk deletion gap');
    const local = await writer.write({ ...request, requestedClass: 'LOCAL' });
    await accept(a, 'sdk-delete-gap');
    expect(await writer.delete(local.id ?? '')).toBe(true);
    expect(await writer.search('sdk deletion gap')).toEqual([]);
    expect(await a.search('sdk deletion gap')).toEqual([
      expect.objectContaining({ id: 'sdk-delete-gap', path: `dolt-poc:${project}:sdk-delete-gap` }),
    ]);
    expect(await a.delete('sdk-delete-gap')).toBe(true);
    expect(await writer.search('sdk deletion gap')).toEqual([]);
    const promoteRequest = await fixture('sdk-promote-gap', 'Synthetic sdk promotion gap');
    const before = await writer.write({ ...promoteRequest, requestedClass: 'LOCAL' });
    await accept(a, 'sdk-promote-gap');
    const promoted = await writer.promote(before.id ?? '', 'DECISION', reviewer);
    expect(promoted.stored).toBe(true);
    expect((await a.inspect('sdk-promote-gap'))?.status).toBe('accepted');
    expect((await writer.search('sdk promotion gap')).some(result => result.id === 'sdk-promote-gap')).toBe(false);
    // A new unrelated local root has not received the lifecycle exclusions.
    expect(await sdk(a).search('sdk promotion gap')).toEqual([
      expect.objectContaining({ id: 'sdk-promote-gap', class: 'LOCAL' }),
    ]);
    const replacement = await fixture('sdk-promote-successor', 'Synthetic explicitly promoted replacement');
    replacement.classification = await classifyStore.classify({ content: replacement.content, requestedClass: 'DECISION' });
    await a.write(replacement);
    await accept(a, 'sdk-promote-successor');
    await a.retire('sdk-promote-gap', 'superseded', reviewer, 'sdk-promote-successor');
    expect(await sdk(a).search('sdk promotion gap')).toEqual([]);
    expect(await sdk(a).search('explicitly promoted replacement')).toEqual([
      expect.objectContaining({ id: 'sdk-promote-successor', class: 'DECISION', provider: 'dolt-poc' }),
    ]);
    await a.cli.checkpoint('Record SDK gap and explicit sample lifecycle controls');
    await a.cli.push();
    await b.cli.pull();
    console.log('SDK EXCLUSION: correlated local delete/promote hide old provider IDs; provider copies remain until explicitly retired; unrelated roots do not inherit exclusions');
  });

  test('stale candidates cannot enter the existing memory tool context after restart and stale-clone sync', async () => {
    if (!runRoot) throw new Error('Missing run directory');
    const stateRoot = path.join(runRoot, 'durable-sdk-state');
    await mkdir(stateRoot);
    const forgotten = 'CONTEXT-STALE-FORGOTTEN-ALPHA';
    const superseded = 'CONTEXT-STALE-SUPERSEDED-BETA';
    const control = 'CONTEXT-CURRENT-VALID-GAMMA';
    const pinned: MemoryProviderSearchResult[] = [];
    class HistoricalCandidates implements MemoryProvider {
      readonly id = a.id;
      readonly name = 'Synthetic historical candidate exposure';
      readonly supportedClasses = a.supportedClasses;
      returned: MemoryProviderSearchResult[] = [];
      constructor(readonly base: DoltMemoryProvider) {}
      status() { return this.base.status(); }
      write(request: CopilotMemoryProviderWriteRequest) { return this.base.write(request); }
      delete(id: string) { return this.base.delete(id); }
      async search(query: string) {
        const current = await this.base.search(query);
        this.returned = [...current.filter(row => !pinned.some(old => old.id === row.id)), ...pinned];
        return this.returned;
      }
    }
    const exposed = new HistoricalCandidates(a);
    const storage = new FSStorageProvider(stateRoot);
    const writer = new LocalMemoryStore(storage, stateRoot, { registeredProviders: [exposed] });
    const locals = new Map<string, string>();
    for (const [id, marker] of [['boundary-forget', forgotten], ['boundary-prior', superseded], ['boundary-control', control]]) {
      if (!id || !marker) throw new Error('Invalid synthetic fixture');
      const request = await fixture(id, `Boundary experiment ${marker}`);
      const result = await writer.write({ ...request, requestedClass: 'DECISION' });
      if (!result.id) throw new Error('Missing local id');
      locals.set(id, result.id);
      await accept(a, id);
    }
    pinned.push(...(await a.search('Boundary experiment')).filter(row => row.id === 'boundary-forget' || row.id === 'boundary-prior'));
    expect(pinned.map(row => row.class)).toEqual(['DECISION', 'DECISION']);
    const modelContext = async (provider: MemoryProvider): Promise<{ toolText: string; prompt: string }> => {
      const registry = new ToolRegistry(path.join(stateRoot, '.squad'), undefined,
        new FSStorageProvider(stateRoot), undefined, undefined, undefined, [provider]);
      const tool = registry.getTool('memory.search');
      if (!tool) throw new Error('Missing actual memory.search tool');
      const result: unknown = await tool.handler({ query: 'Boundary experiment' }, {
        sessionId: 'synthetic-context-session', toolCallId: 'synthetic-context-call',
        toolName: 'memory.search', arguments: { query: 'Boundary experiment' },
      });
      if (!object(result)) throw new Error('Invalid actual tool response');
      expect(result.resultType).toBe('success');
      const toolText = text(result, 'textResultForLlm');
      // Explicit host composition with the real compiler, not automatic runtime wiring.
      const compiled = compileCharterFull({
        agentName: 'synthetic-agent', charterPath: path.join(stateRoot, 'synthetic-charter.md'),
        charterContent: '# Synthetic agent\n\nSynthetic context experiment.',
        decisions: toolText,
      });
      return { toolText, prompt: compiled.prompt };
    };
    const before = await modelContext(exposed);
    expect(before.prompt).toContain(forgotten);
    expect(before.prompt).toContain(superseded);
    expect(before.prompt).toContain(control);
    await a.cli.checkpoint('Context experiment accepted ancestor');
    await a.cli.push();
    await b.cli.pull();
    const staleRequests = await Promise.all(['boundary-forget', 'boundary-prior'].map(id => b.inspect(id)));

    expect(await writer.delete(locals.get('boundary-forget') ?? '')).toBe(true);
    const promoted = await writer.promote(locals.get('boundary-prior') ?? '', 'POLICY', reviewer);
    expect(promoted.stored).toBe(true);
    // Promotion copies content unchanged. Retire that intermediate local copy
    // explicitly before introducing a reviewed replacement with different text.
    expect(await writer.delete(promoted.id ?? '')).toBe(true);
    const replacement = await fixture('boundary-successor', 'Boundary experiment CONTEXT-CURRENT-REPLACEMENT-DELTA');
    expect((await writer.write({ ...replacement, requestedClass: 'DECISION' })).stored).toBe(true);
    await accept(a, 'boundary-successor');
    expect(await a.delete('boundary-forget')).toBe(true);
    expect(await a.retire('boundary-prior', 'superseded', reviewer, 'boundary-successor')).toBe(true);
    await a.cli.checkpoint('Context experiment provider retirements');
    await a.cli.push();

    for (const stale of staleRequests) {
      if (!stale) throw new Error('Missing stale clone ancestor');
      await b.write({ ...stale.request, content: `${stale.request.content} offline stale rewrite` });
      await accept(b, stale.id);
    }
    expect((await b.search('offline stale rewrite')).map(row => row.id)).toEqual(['boundary-forget', 'boundary-prior']);
    await b.cli.checkpoint('Context experiment actual stale rewrites');
    await b.cli.pull();
    await b.cli.push();
    await a.cli.pull();
    expect(await a.search('offline stale rewrite')).toEqual([]);

    const restartedProvider = new HistoricalCandidates(new DoltMemoryProvider(new DoltCli(a.cli.directory), project));
    const restarted = new LocalMemoryStore(new FSStorageProvider(stateRoot), stateRoot, {
      registeredProviders: [restartedProvider],
    });
    const results = await restarted.search('Boundary experiment');
    expect(restartedProvider.returned).toContainEqual(expect.objectContaining({ id: 'boundary-forget', snippet: expect.stringContaining(forgotten) }));
    expect(restartedProvider.returned).toContainEqual(expect.objectContaining({ id: 'boundary-prior', snippet: expect.stringContaining(superseded) }));
    expect(results).toContainEqual(expect.objectContaining({ snippet: expect.stringContaining(control) }));
    const after = await modelContext(restartedProvider);
    expect(restartedProvider.returned.map(row => row.id)).toContain('boundary-prior');
    expect(after.prompt).not.toContain(forgotten);
    expect(after.prompt).not.toContain(superseded);
    expect(after.toolText).not.toContain(forgotten);
    expect(after.toolText).not.toContain(superseded);
    expect(results.some(row => row.snippet.includes(forgotten) || row.snippet.includes(superseded))).toBe(false);
    expect(after.prompt).toContain(control);
    expect(after.prompt).toContain('CONTEXT-CURRENT-REPLACEMENT-DELTA');
    console.log('CONTEXT BEFORE: both historical DECISION markers and current control present');
    console.log('CONTEXT AFTER: provider returned both historical markers after disk restart + actual stale-clone write/sync; SDK search, real memory.search LLM text, and host-composed charter omit both; valid control+replacement remain');
  });

  test('conflicting edits surface to caller and unresolved conflicts block retrieval/writes', async () => {
    await accepted(a, 'conflict', 'Synthetic common reviewed content');
    await a.cli.checkpoint('Common conflict ancestor');
    await a.cli.push();
    await b.cli.pull();
    await a.write(await fixture('conflict', 'Synthetic divergent content A'));
    await a.cli.checkpoint('A conflicting edit');
    await a.cli.push();
    await b.write(await fixture('conflict', 'Synthetic divergent content B'));
    await b.cli.checkpoint('B conflicting edit');
    await expect(b.cli.pull()).rejects.toThrow(/Dolt pull failed|explicit review required/);
    const conflicts = await b.cli.rows('SELECT * FROM dolt_conflicts');
    expect(conflicts).toEqual([expect.objectContaining({ table: 'memories' })]);
    const details = await b.cli.rows('SELECT * FROM dolt_conflicts_memories');
    expect(details).toHaveLength(1);
    expect(JSON.stringify(details)).toContain('Synthetic divergent content A');
    expect(JSON.stringify(details)).toContain('Synthetic divergent content B');
    expect(await b.status()).toMatchObject({ available: false, reason: expect.stringContaining('explicit review required') });
    await expect(b.search('Synthetic')).rejects.toThrow('explicit review required');
    await expect(b.write(await fixture('blocked-write'))).rejects.toThrow('explicit review required');
    await expect(b.cli.push()).rejects.toThrow('explicit review required');
    expect(await a.search('Synthetic divergent')).toEqual([]); // Changed hash has no approval.
    console.log('CONFLICT: same-key A/B payload divergence exposed in dolt_conflicts_memories; B fails closed; A changed payload remains unapproved');
    // Preserve conflict evidence with DOLT_POC_KEEP=1; do not auto-pick a winner.
  });
});
