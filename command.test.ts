import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DoltCli, DoltMemoryProvider, literal, text } from './provider.js';

describe('command and input failures (no mock engine)', () => {
  test('missing executable fails loudly and status reports unavailable', async () => {
    const cli = new DoltCli(process.cwd(), path.join(process.cwd(), 'does-not-exist-dolt-poc.exe'));
    await expect(cli.run('version')).rejects.toThrow('Dolt version failed');
    expect(await new DoltMemoryProvider(cli, 'synthetic-project').status()).toMatchObject({
      available: false, reason: expect.stringContaining('Dolt sql failed'),
    });
  });

  test('scope validation and SQL literals are exact, not fuzzy or shell escaped', () => {
    expect(() => new DoltMemoryProvider(new DoltCli('.'), '')).toThrow('exact project scope');
    expect(() => new DoltMemoryProvider(new DoltCli('.'), 'project/*')).toThrow('exact project scope');
    expect(literal("é'\\")).toBe("CONVERT(X'c3a9275c' USING utf8mb4)");
    expect(literal('')).toBe("CONVERT(X'' USING utf8mb4)");
    expect(() => text({ id: 12 }, 'id')).toThrow('Expected string column: id');
  });
});
