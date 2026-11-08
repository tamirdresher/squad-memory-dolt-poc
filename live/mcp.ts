import { createInterface } from 'node:readline';
import { LiveBridge, readBridgeConfig } from './bridge.js';
import { object } from '../provider.js';

const bridge = new LiveBridge(await readBridgeConfig(process.argv[2] ?? ''));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
// MCP stdio JSON-RPC frames are newline-delimited. Serialize requests to keep write keys isolated.
for await (const line of input) {
  const message: unknown = JSON.parse(line);
  if (!object(message)) throw new Error('Invalid MCP message');
  if (message.id === undefined) continue;
  try {
    let result: unknown;
    switch (message.method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'squad-dolt-experiment-bridge', version: '0.1.0' } };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: bridge.tools() }; break;
      case 'tools/call': {
        if (!object(message.params) || typeof message.params.name !== 'string'
          || !object(message.params.arguments)) throw new Error('Invalid MCP tool call');
        const response = await bridge.call(message.params.name, message.params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(response) }],
          isError: response.resultType !== 'success' };
        break;
      }
      default:
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Method not supported by bounded experiment bridge' } })}\n`);
        continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : 'Bridge failure' } })}\n`);
  }
}
