import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { DoltCli, DoltMemoryProvider, object, text } from '../provider.js';
import type { BridgeConfig } from './bridge.js';
import { finalAnswer, nativeCalls, validateNativeLauncher } from './evidence.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const build = path.dirname(fileURLToPath(import.meta.url));
const native = process.argv.includes('--native');
const nativeEntry = process.env.SQUAD_NATIVE_CLI_ENTRYPOINT;
const nativeModule = process.env.SQUAD_NATIVE_STATE_MCP_MODULE;
if (native && !nativeEntry && !nativeModule) throw new Error('Native experiment requires a modified local Squad CLI entrypoint or stock state-MCP module');
const scratch = path.join(root, '.scratch', 'live');
await mkdir(scratch, { recursive: true });
const runRoot = await mkdtemp(path.join(scratch, 'run-'));
const scope = 'synthetic-live-project';
const facts = {
  'live-forget': 'Live trial release routing code is ROUTE-COBALT-17.',
  'live-prior': 'Live trial release signing code is SIGN-AMBER-29.',
  'live-control': 'Live trial release valid control is CONTROL-JADE-43.',
};
const replacement = 'Live trial release signing code is SIGN-VIOLET-61.';
const cliHome = path.join(runRoot, 'cli-home');
await mkdir(cliHome);
const env = { ...process.env, COPILOT_HOME: cliHome, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '',
  COPILOT_AUTO_UPDATE: 'false', COPILOT_TELEMETRY_DISABLED: 'true', COPILOT_ALLOW_ALL: 'true' };
const agentSource = path.join(root, 'node_modules', '@bradygaster', 'squad-sdk', 'templates', 'squad.agent.md.template');
const coordinator = await readFile(agentSource);
const coordinatorSha256 = createHash('sha256').update(coordinator).digest('hex');
const trials: Array<Record<string, unknown>> = [];

function command(args: string[], cwd: string, timeout = 180_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const stopTree = `function Stop-Tree([int]$target) {
          Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $target | ForEach-Object { Stop-Tree $_.ProcessId };
          Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
        }; Stop-Tree ${child.pid}`;
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', stopTree], { windowsHide: true });
      } else child.kill('SIGTERM');
    }, timeout);
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function cli(args: string[], cwd: string) {
  if (process.env.COPILOT_LIVE_CLI_BIN) {
    const binary = process.env.COPILOT_LIVE_CLI_BIN;
    return command(binary.endsWith('.js') ? [process.execPath, binary, ...args] : [binary, ...args], cwd);
  }
  if (process.platform !== 'win32') return command(['copilot', ...args], cwd);
  const argumentsFile = path.join(runRoot, `cli-args-${randomUUID()}.json`);
  await writeFile(argumentsFile, JSON.stringify(args));
  return command(['powershell.exe', '-NoProfile', '-NonInteractive',
    '-File', path.join(root, 'live', 'invoke-cli.ps1'), '-ArgumentsFile', argumentsFile], cwd);
}

async function traces(file: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => {
    const row: unknown = JSON.parse(line);
    if (!object(row)) throw new Error('Invalid trace');
    return row;
  });
}

async function session(label: string, config: Omit<BridgeConfig, 'sessionId' | 'trace'>, request: string) {
  const directory = path.join(runRoot, 'sessions', label);
  await mkdir(directory, { recursive: true });
  const workspace = native ? config.stateRoot : directory;
  await mkdir(path.join(workspace, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(workspace, '.squad'), { recursive: true });
  await copyFile(agentSource, path.join(workspace, '.github', 'agents', 'squad.agent.md'));
  await writeFile(path.join(workspace, '.squad', 'team.md'),
    '# Synthetic live team\n\n## Members\n\n| Name | Role |\n| --- | --- |\n| Synthetic Member | Fixture specialist |\n');
  const sessionId = randomUUID();
  const trace = path.join(directory, native ? 'native-provider.jsonl' : 'bridge.jsonl');
  await writeFile(trace, '');
  const bridgeConfig = path.join(directory, 'bridge-config.json');
  await writeFile(bridgeConfig, JSON.stringify({ ...config, sessionId, trace }));
  const mcpConfig = path.join(directory, 'mcp.json');
  const serverName = native ? 'squadnative' : 'memorybridge';
  if (native) {
    const moduleDir = path.join(workspace, '.squad', 'providers');
    await mkdir(path.join(moduleDir, 'live'), { recursive: true });
    await copyFile(path.join(build, 'native-factory.js'), path.join(moduleDir, 'live', 'native-factory.mjs'));
    await copyFile(path.join(build, '..', 'provider.js'), path.join(moduleDir, 'provider.js'));
    await writeFile(path.join(moduleDir, 'package.json'), '{"type":"module"}\n');
    await writeFile(path.join(workspace, '.squad', 'config.json'), JSON.stringify({ stateBackend: 'local', memory: {
      providers: [{ module: '.squad/providers/live/native-factory.mjs', trusted: true,
        options: { clone: config.clone, scope: config.scope, trace, historicalCandidates: config.historicalCandidates } }],
    } }));
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { squadnative: {
      type: 'stdio', command: process.execPath, args: nativeModule
        ? ['--input-type=module', '--eval',
          `const {runStateMcp}=await import(${JSON.stringify(pathToFileURL(nativeModule).href)});await runStateMcp();`]
        : [nativeEntry, 'state-mcp'],
      tools: ['memory.write', 'memory.search', 'memory.delete', 'memory.promote'],
    } } }));
  } else {
    await writeFile(path.join(workspace, '.squad', 'config.json'), '{"stateBackend":"local"}\n');
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { memorybridge: {
    type: 'stdio', command: process.execPath, args: [path.join(build, 'mcp.js'), bridgeConfig], tools: ['*'],
    } } }));
  }
  const prompt = 'This is a bounded synthetic Squad Direct Mode factual memory exercise. '
    + 'The local synthetic team is configured. No delegation, nested agents, shell, private files, or other services. '
    + `Only use the ${serverName} governed memory tools. Do not ask questions. `
    + (native ? request.replaceAll('memory_write', 'memory.write').replaceAll('memory_search', 'memory.search')
      .replaceAll('memory_delete', 'memory.delete').replaceAll('memory_promote', 'memory.promote') : request);
  const args = ['--no-auto-update',
    '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user', '--disallow-temp-dir',
    '--agent', 'Squad', '--session-id', sessionId, '--name', `Dolt synthetic ${label}`,
    '--additional-mcp-config', `@${mcpConfig}`, '--available-tools', serverName,
    '--allow-tool', serverName, '--output-format', 'json', '--stream', 'off',
    '--log-dir', path.join(directory, 'logs'), '-p', prompt];
  const output = await cli(args, workspace);
  await writeFile(path.join(directory, 'stdout.jsonl'), output.stdout);
  await writeFile(path.join(directory, 'stderr.txt'), output.stderr);
  const providerTrace = await traces(trace);
  const calls = native ? nativeCalls(output.stdout, providerTrace) : providerTrace;
  if (native) assert(providerTrace.some(row => row.event === 'native-provider-discovered'
    && row.providerId === 'dolt-poc'), 'Stock runtime never discovered configured Dolt provider');
  assert(calls.length > 0, `No genuine runtime MCP tool invocation in ${label}; inspect raw CLI trace`);
  const answer = finalAnswer(output.stdout);
  const trial = { label, sessionId, prompt, answer, calls,
    ...(native ? { discovery: providerTrace.filter(row => row.event === 'native-provider-discovered'),
      providerWrites: providerTrace.filter(row => row.event === 'native-provider-write') } : {}) };
  trials.push(trial);
  console.log(`LIVE ${label}: ${sessionId}; ${calls.length} actual ${native ? 'stock Squad MCP' : 'bridge'} tool calls`);
  return trial;
}

async function accept(provider: DoltMemoryProvider, id: string) {
  const record = await provider.inspect(id);
  assert(record, `Missing real provider write ${id}`);
  await provider.accept(id, record.fingerprint, 'synthetic-live-reviewer');
}

try {
  let nativeLaunch: Record<string, unknown> | undefined;
  if (native && nativeEntry && !nativeModule) {
    const launcherVersion = await command([process.execPath, nativeEntry, '--version'], runRoot);
    const launcherHelp = await command([process.execPath, nativeEntry, '--help'], runRoot);
    const launcher = validateNativeLauncher(launcherVersion.stdout, launcherHelp.stdout);
    nativeLaunch = { mode: 'full-cli-entrypoint', ...launcher,
      entrypoint: 'packages/squad-cli/dist/cli-entry.js', mcpArguments: ['state-mcp'],
      entrypointSha256: createHash('sha256').update(await readFile(nativeEntry)).digest('hex'),
      directFunctionBypass: false };
    console.log(`SQUAD LAUNCHER ${launcherVersion.stdout.trim()}: full cli-entry.js state-mcp, no direct-function bypass`);
  } else if (native && nativeModule) {
    nativeLaunch = { mode: 'direct-stock-module', directFunctionBypass: true };
  }
  const version = await cli(['--version', '--no-auto-update'], runRoot);
  const help = await cli(['--help', '--no-auto-update'], runRoot);
  for (const flag of ['--agent', '--session-id', '--additional-mcp-config', '--available-tools',
    '--allow-tool', '--output-format', '--stream', '--no-ask-user', '--disable-builtin-mcps',
    '--no-custom-instructions', '--disallow-temp-dir', '--log-dir']) {
    assert(help.stdout.includes(flag), `Installed CLI does not support ${flag}; select a supported installed CLI entrypoint`);
  }
  console.log(version.stdout.trim());
  console.log(`PRIVATE RUN: ${path.relative(root, runRoot)}`);
  const seedPath = path.join(runRoot, 'seed');
  const remotePath = path.join(runRoot, 'remote');
  await mkdir(seedPath); await mkdir(remotePath);
  const seed = new DoltCli(seedPath);
  const engine = (await seed.run('version')).trim();
  await seed.run('init', '--name', 'Synthetic Reviewer', '--email', 'reviewer@example.invalid', '-b', 'main');
  await new DoltMemoryProvider(seed, scope).initialize();
  await seed.checkpoint('Synthetic live schema');
  const remote = pathToFileURL(remotePath).href;
  await seed.run('remote', 'add', 'origin', remote);
  await seed.run('push', '--set-upstream', 'origin', 'main');
  const rootCli = new DoltCli(runRoot);
  await rootCli.run('clone', remote, 'clone-a'); await rootCli.run('clone', remote, 'clone-b');
  const a = new DoltMemoryProvider(new DoltCli(path.join(runRoot, 'clone-a')), scope);
  const b = new DoltMemoryProvider(new DoltCli(path.join(runRoot, 'clone-b')), scope);
  for (const provider of [a, b]) {
    await provider.cli.run('config', '--local', '--add', 'user.name', 'Synthetic Reviewer');
    await provider.cli.run('config', '--local', '--add', 'user.email', 'reviewer@example.invalid');
  }
  const stateA = path.join(runRoot, 'state-a');
  const stateB = path.join(runRoot, 'state-b');
  await mkdir(stateA); await mkdir(stateB);
  const configA = { clone: a.cli.directory, stateRoot: stateA, scope };
  const configB = { clone: b.cli.directory, stateRoot: stateB, scope };
  const writer = await session('writer', configA, 'Use memory_write once for EACH of these three synthetic facts, '
    + 'with class DECISION, author synthetic-live-operator, title Live trial fact, and the specified memoryId: '
    + (native ? Object.values(facts).join(' ') : JSON.stringify(facts))
    + (native ? '. Do not supply any memoryId or metadata; native runtime supplies stable identity.' : '')
    + '. Confirm which three writes succeeded; do not search.');
  const localIds = new Map<string, string>();
  for (const row of writer.calls) {
    if (native) {
      if (row.tool !== 'memory.write' || !object(row.args)) continue;
      const content = row.args.content;
      const fact = Object.entries(facts).find(([, value]) => value === content);
      const write = writer.providerWrites?.find(item => item.content === content);
      assert(fact && write);
      localIds.set(fact[0], text(write, 'sourceId'));
      continue;
    }
    if (row.tool !== 'memory.write' || !object(row.args) || !object(row.result)
      || !object(row.result.toolTelemetry)) continue;
    localIds.set(text(row.args, 'memoryId'), text(row.result.toolTelemetry, 'id'));
  }
  assert.equal(localIds.size, 3, 'Writer must invoke all three real governed writes');
  assert(writer.calls.every(row => object(row.result) && row.result.resultType === 'success'));
  function providerId(id: string) { return native ? `native-${localIds.get(id)}` : id; }
  for (const id of Object.keys(facts)) await accept(a, providerId(id));
  await a.cli.checkpoint('Host explicitly reviews live tool writes'); await a.cli.push(); await b.cli.pull();
  const historical = await a.search('Live trial');
  assert.equal(historical.length, 3);
  const reader = await session('reader', configB,
    'Call memory_search with query "Live trial", then report the release routing code, signing code, and valid control '
    + 'strictly from that tool response. Quote the three values. Do not write.');
  const readerSearch = reader.calls.find(row => row.tool === 'memory.search');
  assert(readerSearch && object(readerSearch.result));
  for (const marker of ['ROUTE-COBALT-17', 'SIGN-AMBER-29', 'CONTROL-JADE-43']) {
    assert(text(readerSearch.result, 'textResultForLlm').includes(marker), 'Reader provider did not return accepted fact');
    assert(reader.answer.includes(marker), `Independent reader did not answer with ${marker}`);
  }
  const pinned = historical.filter(row => row.id !== providerId('live-control'));
  const forget = await session('forget-fresh', { ...configA, historicalCandidates: pinned },
    `Call memory_delete for local id "${localIds.get('live-forget')}" with actor synthetic-live-operator. `
    + 'Then call memory_search query "Live trial". Report only currently returned release facts and control; do not guess missing facts.');
  const forgetSearch = forget.calls.find(row => row.tool === 'memory.search');
  assert(forgetSearch && object(forgetSearch.result));
  assert(JSON.stringify(forgetSearch.candidates).includes('ROUTE-COBALT-17'), 'Core path was not challenged with stale candidate');
  assert(!text(forgetSearch.result, 'textResultForLlm').includes('ROUTE-COBALT-17'));
  assert(text(forgetSearch.result, 'textResultForLlm').includes('SIGN-AMBER-29'));
  assert(!forget.answer.includes('ROUTE-COBALT-17'));
  assert(forget.answer.includes('CONTROL-JADE-43'));
  assert.equal(await a.delete(providerId('live-forget')), true);
  await a.cli.checkpoint('Host explicitly retires forgotten provider copy'); await a.cli.push();
  const promote = await session('supersede-fresh', configA,
    `Call memory_promote for local id "${localIds.get('live-prior')}" to POLICY with actor synthetic-live-operator. `
    + 'Promotion preserves content: immediately memory_delete the NEW local id returned by promotion. '
    + `Then memory_write ${native ? '' : 'memoryId live-successor, '}class DECISION, author synthetic-live-operator, title Live trial replacement, content "${replacement}". `
    + 'Confirm those three actions succeeded. Do not search: host review of the proposed replacement occurs next.');
  const promotion = promote.calls.find(row => row.tool === 'memory.promote');
  assert(promotion && object(promotion.result));
  const promotedId = native ? text(promotion.result, 'textResultForLlm').match(/ as ([a-f0-9-]{36})/)?.[1]
    : object(promotion.result.toolTelemetry) ? text(promotion.result.toolTelemetry, 'targetId') : undefined;
  assert(promotedId);
  assert(promote.calls.some(row => row.tool === 'memory.delete'
    && object(row.args) && row.args.id === promotedId
    && object(row.result) && row.result.resultType === 'success'), 'Legitimate unchanged successor was not deleted');
  assert(promote.calls.some(row => row.tool === 'memory.write'
    && object(row.args) && (native ? row.args.content === replacement : row.args.memoryId === 'live-successor')
    && object(row.result) && row.result.resultType === 'success'));
  if (native) {
    const write = promote.providerWrites?.find(row => row.content === replacement);
    assert(write); localIds.set('live-successor', text(write, 'sourceId'));
  }
  await accept(a, providerId('live-successor'));
  const supersede = await session('supersede-check-fresh', { ...configA, historicalCandidates: pinned },
    'Call memory_search query "Live trial"; report only the current signing fact and valid control from the response. '
    + 'Do not infer absent facts or use other sources.');
  const after = [...supersede.calls].reverse().find(row => row.tool === 'memory.search');
  assert(after && object(after.result));
  for (const marker of ['ROUTE-COBALT-17', 'SIGN-AMBER-29']) {
    assert(JSON.stringify(after.candidates).includes(marker), 'Core candidate challenge missing');
    assert(!text(after.result, 'textResultForLlm').includes(marker), 'Retired candidate admitted to actual runtime tool');
  }
  assert(text(after.result, 'textResultForLlm').includes('CONTROL-JADE-43'));
  assert(text(after.result, 'textResultForLlm').includes('SIGN-VIOLET-61'));
  for (const marker of ['ROUTE-COBALT-17', 'SIGN-AMBER-29']) assert(!supersede.answer.includes(marker));
  for (const marker of ['CONTROL-JADE-43', 'SIGN-VIOLET-61']) assert(supersede.answer.includes(marker));
  await a.retire(providerId('live-prior'), 'superseded', 'synthetic-live-reviewer', providerId('live-successor'));
  await a.cli.checkpoint('Host reviews replacement and retires superseded copy'); await a.cli.push();
  // B is still offline from BOTH retirements: actually rewrite and accept the old keys before merge.
  for (const id of ['live-forget', 'live-prior']) {
    const stale = await b.inspect(providerId(id)); assert(stale);
    await b.write({ ...stale.request, content: `${stale.request.content} Synthetic offline stale rewrite.` });
    await accept(b, providerId(id));
  }
  assert.equal((await b.search('offline stale rewrite')).length, 2);
  await b.cli.checkpoint('Actual offline stale key rewrites');
  await b.cli.pull(); await b.cli.push(); await a.cli.pull();
  assert.equal((await b.search('offline stale rewrite')).length, 0);
  const final = await session('final-independent-fresh', configB,
    'Call memory_search query "Live trial". Report current release facts and valid control strictly from that tool response. '
    + 'Do not infer absent facts, do not write, and do not use any other source.');
  const finalSearch = final.calls.find(row => row.tool === 'memory.search');
  assert(finalSearch && object(finalSearch.result));
  for (const marker of ['ROUTE-COBALT-17', 'SIGN-AMBER-29']) {
    assert(!text(finalSearch.result, 'textResultForLlm').includes(marker));
    assert(!final.answer.includes(marker));
  }
  for (const marker of ['CONTROL-JADE-43', 'SIGN-VIOLET-61']) assert(final.answer.includes(marker));
  const nativeCoreDiscoveryAudit = native ? await Promise.all(([['A', stateA], ['B', stateB]] as const)
    .map(async ([durableRoot, stateRoot]) => {
      const records = (await traces(path.join(stateRoot, '.squad', 'memory', 'audit.jsonl')))
        .filter(row => row.action === 'configure' && row.provider === 'dolt-poc')
        .map(row => ({ action: row.action, provider: row.provider, path: row.path, reason: row.reason }));
      assert(records.length > 0, `Native SDK has no durable factory discovery audit for root ${durableRoot}`);
      return { durableRoot, records };
    })) : undefined;
  const evidence = {
    observedAt: new Date().toISOString(), cliVersion: version.stdout.trim(), engine, coordinatorSha256,
    integration: native ? 'modified LOCAL Squad SDK build; stock squad state-mcp discovers trusted project provider factory'
      : 'public Squad custom agent + sample-specific stdio MCP bridge to actual SDK ToolRegistry and Dolt provider',
    trials, topology: 'two real clones + filesystem remote; separate durable local SDK roots A and B',
    ...(native ? { nativeCoreDiscoveryAudit } : {}),
    ...(native ? { nativeLaunch } : {}),
    hostActions: 'exact-fingerprint acceptance, explicit SQL retirement and checkpoint/push/pull; actual stale B rewrites',
    result: 'PASS', offlineChallenge: { staleAcceptedBeforeMerge: 2, staleReturnedAfterMerge: 0 },
    durableRoots: { writer: 'A', reader: 'B', forget: 'A (restarted)', supersede: 'A (restarted)',
      supersedeCheck: 'A (restarted)', final: 'B (restarted)' },
  };
  const sanitized = JSON.stringify(evidence, null, 2);
  // Only selected synthetic fields, never raw JSONL usage/auth/configuration, become public evidence.
  await writeFile(path.join(runRoot, 'evidence.json'), sanitized);
  await writeFile(path.join(root, 'docs', native ? 'NATIVE-EVIDENCE.json' : 'LIVE-EVIDENCE.json'), sanitized + '\n');
  console.log(`LIVE PASS: ${trials.length} fresh real CLI Squad sessions. Raw evidence retained only under ${path.relative(root, runRoot)}.`);
} catch (error) {
  await writeFile(path.join(runRoot, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`LIVE FAILED: inspect private artifact ${path.relative(root, runRoot)}; no live success is claimed.`);
  throw error;
}
