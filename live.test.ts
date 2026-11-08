import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LocalMemoryStore } from '@bradygaster/squad-sdk/memory';
import { InMemoryStorageProvider } from '@bradygaster/squad-sdk/storage';
import { LiveBridge, readBridgeConfig } from './live/bridge.js';
import { finalAnswer, nativeCalls, validateNativeLauncher } from './live/evidence.js';
import { createMemoryProvider } from './live/native-factory.js';

const roots: string[] = [];
async function fixture() {
  const root = path.resolve('.scratch', `bridge-test-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  const config = { clone: path.join(root, 'clone'), stateRoot: root, scope: 'synthetic-test',
    sessionId: randomUUID(), trace: path.join(root, 'trace.jsonl') };
  await writeFile(config.trace, '');
  return { root, config };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('live bridge contracts (not live model evidence)', () => {
  it('validates actual normal launcher command help despite ANSI styling, not only a successful exit', () => {
    expect(validateNativeLauncher('0.13.1\n', '\u001b[1msquad\u001b[0m v0.13.1\nmemory\nstate-mcp\n'))
      .toEqual({ squadVersion: '0.13.1', helpConfirmed: ['squad v', 'memory', 'state-mcp'] });
    expect(() => validateNativeLauncher('0.13.1', 'squad v0.13.1 memory')).toThrow('state-mcp');
    expect(() => validateNativeLauncher('not a version', 'squad v memory state-mcp')).toThrow('actual version');
  });
  it('native factory records discovery and rejects unstable identity before external persistence', async () => {
    const { root, config } = await fixture();
    const provider = await createMemoryProvider({ projectRoot: root, squadRoot: path.join(root, '.squad'),
      options: { clone: config.clone, scope: config.scope, trace: config.trace } });
    expect(provider.id).toBe('dolt-poc');
    const request = { content: 'synthetic control', author: 'synthetic', title: 'Synthetic',
      classification: await new LocalMemoryStore(new InMemoryStorageProvider(), root)
        .classify({ content: 'synthetic control', requestedClass: 'DECISION' }) };
    await expect(provider.write(request)).rejects.toThrow('stable persisted sourceId');
    const trace = JSON.parse((await readFile(config.trace, 'utf8')).trim());
    expect(trace).toMatchObject({ event: 'native-provider-discovered', providerId: 'dolt-poc', configOrigin: '.squad/config.json' });
  });
  it('native evidence uses actual MCP tool identity and preserves candidates separately from admitted content', () => {
    const events = [
      { type: 'tool.execution_start', data: { toolCallId: 'synthetic-call', toolName: 'squadnative-memory-search',
        mcpToolName: 'memory.search', arguments: { query: 'synthetic' }, mcpTransport: 'stdio' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'synthetic-call', success: true, result: { content: 'CONTROL' } } },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(nativeCalls(events, [{ event: 'native-provider-candidates', candidates: [{ id: 'retired', snippet: 'OBSOLETE' }] }]))
      .toEqual([expect.objectContaining({ tool: 'memory.search', args: { query: 'synthetic' },
        candidates: [{ id: 'retired', snippet: 'OBSOLETE' }], result: { textResultForLlm: 'CONTROL', resultType: 'success' } })]);
    expect(() => nativeCalls(events, [])).toThrow('no actual provider candidate');
    expect(() => nativeCalls(events.split('\n')[0]!, [])).toThrow('No complete');
  });
  it('only exposes the actual four SDK tools and requires a stable write key', async () => {
    const { config } = await fixture();
    const tools = new LiveBridge(config).tools();
    expect(tools.map(tool => tool.name)).toEqual(['memory_write', 'memory_search', 'memory_delete', 'memory_promote']);
    const schema = tools[0]!.inputSchema;
    expect(schema.required).toContain('memoryId');
    expect(schema.properties).toHaveProperty('content');
    expect(schema.properties).toHaveProperty('memoryId');
  });
  it('rejects unknown tools and invalid keys before any external write', async () => {
    const { config } = await fixture();
    const bridge = new LiveBridge(config);
    await expect(bridge.call('shell', {})).rejects.toThrow('Unknown bridge tool');
    await expect(bridge.call('memory_write', { memoryId: '../escape' })).rejects.toThrow('Invalid stable');
    await expect(bridge.call('memory_write', {})).rejects.toThrow('memoryId');
    expect(await readFile(config.trace, 'utf8')).toBe('');
  });
  it('validates configuration and historical candidate shapes', async () => {
    const { root, config } = await fixture();
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify(config));
    expect(await readBridgeConfig(file)).toEqual(config);
    await writeFile(file, JSON.stringify({ ...config, scope: '' }));
    await expect(readBridgeConfig(file)).rejects.toThrow('scope');
    await writeFile(file, JSON.stringify({ ...config, historicalCandidates: [{}] }));
    await expect(readBridgeConfig(file)).rejects.toThrow('id');
  });
  it('does not mistake tool echoes or usage payloads for final model answers', () => {
    const tool = { type: 'tool.execution_complete', data: { content: 'OBSOLETE-ECHO' } };
    const interim = { type: 'assistant.message', data: { content: 'OBSOLETE-INTERIM', toolRequests: [{}] } };
    const answer = { type: 'assistant.message', data: { phase: 'final_answer', content: 'CURRENT-CONTROL' } };
    expect(finalAnswer([tool, interim, answer].map(event => JSON.stringify(event)).join('\n')))
      .toBe('CURRENT-CONTROL');
    expect(() => finalAnswer(JSON.stringify(tool))).toThrow('no actual final');
    expect(() => finalAnswer('not json')).toThrow();
  });
  it('runs genuine stdio MCP initialization/list/ping framing without starting a model', async () => {
    const { root, config } = await fixture();
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify(config));
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'unknown' },
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join('.scratch', 'live-build', 'live', 'mcp.js'), file]);
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('MCP framing test timed out')); }, 15_000);
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(output); else reject(new Error(`MCP exited ${code}: ${errors}`));
      });
      child.stdin.end(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    });
    const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(replies.map(reply => reply.id)).toEqual([1, 2, 3, 4]);
    expect(replies[0].result.serverInfo.name).toBe('squad-dolt-experiment-bridge');
    expect(replies[1].result.tools).toHaveLength(4);
    expect(replies[2].result).toEqual({});
    expect(replies[3].error.code).toBe(-32601);
    expect(await readFile(config.trace, 'utf8')).toBe('');
  });
});
