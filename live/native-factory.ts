import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CopilotMemoryProviderWriteRequest, MemoryProvider, MemoryProviderSearchResult } from '@bradygaster/squad-sdk/memory';
import { DoltCli, DoltMemoryProvider, object, text } from '../provider.js';

/** Trusted project factory. No MCP server, ToolRegistry injection, or tool-schema translation. */
export async function createMemoryProvider(context: {
  projectRoot: string; squadRoot: string; options: Record<string, unknown>;
}): Promise<MemoryProvider> {
  const { options } = context;
  const scope = text(options, 'scope');
  const trace = text(options, 'trace');
  const base = new DoltMemoryProvider(new DoltCli(text(options, 'clone')), scope);
  const pinned: MemoryProviderSearchResult[] = [];
  if (options.historicalCandidates !== undefined) {
    if (!Array.isArray(options.historicalCandidates)) throw new Error('Invalid native historical candidate fixture');
    for (const candidate of options.historicalCandidates) {
      if (!object(candidate)) throw new Error('Invalid native candidate');
      for (const key of ['id', 'title', 'snippet', 'class', 'loadGuidance', 'path']) text(candidate, key);
      pinned.push(candidate as unknown as MemoryProviderSearchResult);
    }
  }
  async function log(row: Record<string, unknown>) { await appendFile(trace, JSON.stringify(row) + '\n'); }
  await log({ event: 'native-provider-discovered', providerId: base.id, configOrigin: '.squad/config.json',
    module: path.relative(context.projectRoot, fileURLToPath(import.meta.url)) });
  return {
    id: base.id, name: base.name, supportedClasses: base.supportedClasses,
    status: () => base.status(), delete: id => base.delete(id),
    write: async (request: CopilotMemoryProviderWriteRequest & { sourceId?: string }) => {
      if (!request.sourceId || !/^[a-f0-9-]{36}$/.test(request.sourceId)) {
        throw new Error('Native local build must supply a stable persisted sourceId');
      }
      const result = await base.write({ ...request,
        metadata: { ...request.metadata, project: scope, memoryId: `native-${request.sourceId}` } });
      await log({ event: 'native-provider-write', sourceId: request.sourceId,
        content: request.content, result });
      return result;
    },
    search: async query => {
      const current = await base.search(query);
      const candidates = [...current.filter(row => !pinned.some(old => old.id === row.id)), ...pinned];
      await log({ event: 'native-provider-candidates', query, candidates });
      return candidates;
    },
  };
}
