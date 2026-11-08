import { object, text } from '../provider.js';
import { stripVTControlCharacters } from 'node:util';

export function validateNativeLauncher(version: string, help: string) {
  const squadVersion = stripVTControlCharacters(version).trim();
  const output = stripVTControlCharacters(help);
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(squadVersion)) {
    throw new Error('Ordinary Squad launcher must report its actual version');
  }
  const helpConfirmed = ['squad v', 'memory', 'state-mcp'];
  if (!helpConfirmed.every(command => output.includes(command))) {
    throw new Error('Ordinary Squad launcher must expose actual Squad memory and state-mcp command help');
  }
  return { squadVersion, helpConfirmed };
}

/** Only final assistant content counts as an answer, never tool echoes or usage events. */
export function finalAnswer(stdout: string): string {
  const answers: string[] = [];
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const event: unknown = JSON.parse(line);
    if (!object(event)) throw new Error('Invalid CLI JSON event');
    if (event.type !== 'assistant.message' || !object(event.data)
      || event.data.phase !== 'final_answer') continue;
    answers.push(text(event.data, 'content'));
  }

  if (answers.length === 0) throw new Error('CLI emitted no actual final assistant answer');
  return answers.join('\n');
}

/** Selected actual stock CLI tool events; no prompt/cache/API/environment events are retained. */
export function nativeCalls(stdout: string, providerTrace: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  const byId = new Map<string, Record<string, unknown>>();
  let candidateIndex = 0;
  const candidates = providerTrace.filter(row => row.event === 'native-provider-candidates');
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const event: unknown = JSON.parse(line);
    if (!object(event) || !object(event.data)) continue;
    const data = event.data;
    if (event.type === 'tool.execution_start') {
      const name = text(data, 'toolName');
      if (!name.startsWith('squadnative-memory-')) throw new Error(`Unexpected native runtime tool: ${name}`);
      const tool = text(data, 'mcpToolName');
      if (!['memory.write', 'memory.search', 'memory.delete', 'memory.promote'].includes(tool)) {
        throw new Error(`Unexpected stock memory tool: ${tool}`);
      }
      const call = { tool, args: data.arguments,
        runtimeToolName: name, transport: data.mcpTransport };
      byId.set(text(data, 'toolCallId'), call);
      calls.push(call);
    } else if (event.type === 'tool.execution_complete') {
      const call = byId.get(text(data, 'toolCallId'));
      if (!call || !object(data.result)) throw new Error('Unmatched actual native tool completion');
      call.result = { textResultForLlm: text(data.result, 'content'),
        resultType: data.success === true ? 'success' : 'failure' };
      if (call.tool === 'memory.search') {
        const row = candidates[candidateIndex++];
        if (!row) throw new Error('Native search has no actual provider candidate trace');
        call.candidates = row.candidates;
      }
    }
  }
  if (!calls.length || calls.some(call => !object(call.result))) throw new Error('No complete native memory tool calls');
  return calls;
}
