import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '@bradygaster/squad-sdk/tools';
import { FSStorageProvider } from '@bradygaster/squad-sdk/storage';
import type { CopilotMemoryProviderWriteRequest, MemoryProvider, MemoryProviderSearchResult } from '@bradygaster/squad-sdk/memory';
import { DoltCli, DoltMemoryProvider, object, text } from '../provider.js';

export interface BridgeConfig {
  clone: string;
  stateRoot: string;
  scope: string;
  sessionId: string;
  trace: string;
  historicalCandidates?: MemoryProviderSearchResult[];
}

export class LiveBridge {
  private key: string | undefined;
  private candidates: MemoryProviderSearchResult[] = [];
  private readonly registry: ToolRegistry;
  readonly base: DoltMemoryProvider;

  constructor(readonly config: BridgeConfig) {
    this.base = new DoltMemoryProvider(new DoltCli(config.clone), config.scope);
    const provider: MemoryProvider = {
      id: this.base.id, name: this.base.name, supportedClasses: this.base.supportedClasses,
      status: () => this.base.status(),
      delete: id => this.base.delete(id),
      write: async (request: CopilotMemoryProviderWriteRequest) => {
        if (!this.key) throw new Error('Bridge requires an explicit synthetic stable memoryId');
        return this.base.write({
          ...request, metadata: { ...request.metadata, project: config.scope, memoryId: this.key },
        });
      },
      search: async query => {
        const current = await this.base.search(query);
        const pinned = config.historicalCandidates ?? [];
        this.candidates = [...current.filter(row => !pinned.some(old => old.id === row.id)), ...pinned];
        return this.candidates;
      },
    };
    this.registry = new ToolRegistry(path.join(config.stateRoot, '.squad'), undefined,
      new FSStorageProvider(config.stateRoot), undefined, undefined, undefined, [provider]);
  }

  tools() {
    return ['memory.write', 'memory.search', 'memory.delete', 'memory.promote'].map(name => {
      const tool = this.registry.getTool(name);
      if (!tool) throw new Error(`Missing actual Squad tool: ${name}`);
      const parameters: unknown = structuredClone(tool.parameters);
      if (!object(parameters)) throw new Error('Expected upstream JSON tool schema');
      if (name === 'memory.write') {
        if (!object(parameters.properties)) throw new Error('Invalid SDK tool schema');
        parameters.properties.memoryId = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' };
        if (!Array.isArray(parameters.required)) throw new Error('Invalid required schema');
        parameters.required = [...parameters.required, 'memoryId'];
      }
      return { name: name.replace('.', '_'), description: tool.description, inputSchema: parameters };
    });
  }

  async call(name: string, args: Record<string, unknown>) {
    const sdkName = name.replace('_', '.');
    if (!this.tools().some(tool => tool.name === name)) throw new Error(`Unknown bridge tool: ${name}`);
    const tool = this.registry.getTool(sdkName);
    if (!tool) throw new Error('Missing actual tool');
    this.key = sdkName === 'memory.write' ? text(args, 'memoryId')
      : sdkName === 'memory.promote' ? `live-promoted-${randomUUID().slice(0, 8)}` : undefined;
    if (this.key && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(this.key)) throw new Error('Invalid stable synthetic key');
    this.candidates = [];
    try {
      const result: unknown = await tool.handler(args, {
        sessionId: this.config.sessionId, toolCallId: randomUUID(), toolName: sdkName, arguments: args,
      });
      if (!object(result)) throw new Error('Invalid real SDK tool result');
      await appendFile(this.config.trace, `${JSON.stringify({
        sessionId: this.config.sessionId, tool: sdkName, args, providerKey: this.key,
        candidates: this.candidates, result,
      })}\n`);
      return result;
    } finally {
      this.key = undefined;
    }
  }
}

export async function readBridgeConfig(file: string): Promise<BridgeConfig> {
  const config: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!object(config)) throw new Error('Invalid bridge configuration');
  for (const key of ['clone', 'stateRoot', 'scope', 'sessionId', 'trace']) {
    if (!text(config, key).trim()) throw new Error(`Empty bridge configuration: ${key}`);
  }
  if (config.historicalCandidates !== undefined) {
    if (!Array.isArray(config.historicalCandidates)) throw new Error('Invalid historical candidates');
    for (const candidate of config.historicalCandidates) {
      if (!object(candidate)) throw new Error('Invalid historical candidate');
      for (const key of ['id', 'title', 'snippet', 'class', 'loadGuidance', 'path']) text(candidate, key);
      if (!['LOCAL', 'DECISION', 'POLICY'].includes(String(candidate.class))
        || !['ALWAYS', 'ON-DEMAND', 'ARCHIVE', 'NEVER'].includes(String(candidate.loadGuidance))) {
        throw new Error('Invalid historical candidate classification');
      }
    }
  }
  return config as unknown as BridgeConfig;
}
