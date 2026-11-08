import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  CopilotMemoryProviderWriteRequest,
  CopilotMemoryProviderWriteResult,
  MemoryClass,
  MemoryLoadGuidance,
  MemoryProvider,
  MemoryProviderSearchResult,
  MemoryProviderStatus,
} from '@bradygaster/squad-sdk/memory';

const execute = promisify(execFile);
const MAX_BYTES = 16_384;

/** UTF-8 hex literals avoid SQL-mode-dependent quote/backslash escaping. */
export function literal(value: string): string {
  return `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`;
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected string column: ${key}`);
  return value;
}

export class DoltCli {
  constructor(readonly directory: string, readonly executable = process.env.DOLT_BIN ?? 'dolt') {}

  async run(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execute(this.executable, args, {
        cwd: this.directory,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, DOLT_DISABLE_EVENT_FLUSH: 'true' },
      });
      return stdout;
    } catch (error) {
      // Do not echo SQL arguments (which may contain memory payloads).
      const code = object(error) && (typeof error.code === 'string' || typeof error.code === 'number')
        ? String(error.code) : 'unknown';
      const killed = object(error) && error.killed === true;
      throw new Error(`Dolt ${args[0] ?? 'command'} failed (timeout, output limit, or nonzero exit; code=${code}, killed=${killed})`);
    }
  }

  async rows(sql: string): Promise<Record<string, unknown>[]> {
    const output: unknown = JSON.parse(await this.run('sql', '-r', 'json', '-q', sql));
    // Dolt 2.7.2 emits {} rather than {"rows": []} for an empty SELECT.
    if (object(output) && Object.keys(output).length === 0) return [];
    if (!object(output) || !Array.isArray(output.rows) || !output.rows.every(object)) {
      throw new Error('Invalid Dolt JSON result');
    }
    return output.rows;
  }

  async assertCleanMerge(): Promise<void> {
    const issues = await this.rows(`SELECT 'conflict' AS issue FROM dolt_conflicts
      UNION ALL SELECT 'constraint' AS issue FROM dolt_constraint_violations`);
    if (issues.length) {
      throw new Error('Unresolved Dolt conflicts/constraint violations; explicit review required');
    }
  }

  async checkpoint(message: string): Promise<void> {
    await this.assertCleanMerge();
    await this.run('add', '.');
    await this.run('commit', '--allow-empty', '--author', 'Synthetic Reviewer <reviewer@example.invalid>', '-m', message);
  }

  async pull(): Promise<void> {
    await this.run('pull', 'origin', 'main');
    await this.assertCleanMerge();
  }

  async push(): Promise<void> {
    await this.assertCleanMerge();
    await this.run('push', 'origin', 'main');
  }
}

export interface StoredMemory {
  id: string;
  scope: string;
  fingerprint: string;
  request: CopilotMemoryProviderWriteRequest;
  status: 'proposed' | 'accepted' | 'superseded' | 'deleted';
  acceptedBy?: string;
}

function requestFromJson(json: string): CopilotMemoryProviderWriteRequest {
  const value: unknown = JSON.parse(json);
  if (!object(value) || typeof value.content !== 'string' || typeof value.title !== 'string'
    || (value.author !== undefined && typeof value.author !== 'string')
    || !object(value.metadata) || !Object.values(value.metadata).every(v => typeof v === 'string')
    || !object(value.classification)) throw new Error('Invalid stored memory payload');
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.metadata)) {
    if (typeof item !== 'string') throw new Error('Invalid metadata');
    metadata[key] = item;
  }
  const c = value.classification;
  const memoryClass = c.class;
  const guidance = c.loadGuidance;
  const destination = c.destination;
  if ((memoryClass !== 'LOCAL' && memoryClass !== 'DECISION' && memoryClass !== 'POLICY')
    || (guidance !== 'ALWAYS' && guidance !== 'ON-DEMAND' && guidance !== 'ARCHIVE' && guidance !== 'NEVER')
    || (destination !== 'local' && destination !== 'decision-inbox' && destination !== 'policy-inbox')
    || c.allowed !== true || typeof c.reason !== 'string') throw new Error('Invalid stored classification');
  return {
    content: value.content, title: value.title, author: value.author, metadata,
    classification: { class: memoryClass, allowed: true, reason: c.reason, destination, loadGuidance: guidance },
  };
}

/**
 * Optional, scope-bound MemoryProvider; approval/retirement methods below are
 * sample-local lifecycle controls, NOT additions to the SDK's provider seam.
 */
export class DoltMemoryProvider implements MemoryProvider {
  readonly id = 'dolt-poc';
  readonly name = 'Dolt PoC (explicit acceptance)';
  readonly supportedClasses: ReadonlyArray<MemoryClass> = ['LOCAL', 'DECISION', 'POLICY'];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly cli: DoltCli, readonly scope: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope)) throw new Error('An exact project scope is required');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    await this.cli.run('sql', '-q', `
      CREATE TABLE IF NOT EXISTS memories (
        scope VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL,
        fingerprint VARCHAR(64) NOT NULL, payload LONGTEXT NOT NULL,
        PRIMARY KEY (scope, id));
      CREATE TABLE IF NOT EXISTS approvals (
        scope VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL,
        fingerprint VARCHAR(64) NOT NULL, actor VARCHAR(128) NOT NULL,
        PRIMARY KEY (scope, id, fingerprint));
      CREATE TABLE IF NOT EXISTS retirements (
        scope VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL,
        state VARCHAR(16) NOT NULL, successor VARCHAR(64), actor VARCHAR(128) NOT NULL,
        PRIMARY KEY (scope, id));`);
  }

  async status(): Promise<MemoryProviderStatus> {
    try {
      await this.serial(async () => {
        await this.cli.assertCleanMerge();
        await this.cli.rows('SELECT scope FROM memories LIMIT 1');
      });
      return { id: this.id, name: this.name, available: true };
    } catch (error) {
      return { id: this.id, name: this.name, available: false, reason: error instanceof Error ? error.message : 'Dolt unavailable' };
    }
  }

  private key(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid stable memoryId');
    return `scope=${literal(this.scope)} AND id=${literal(id)}`;
  }

  private async inspectInternal(id: string): Promise<StoredMemory | undefined> {
    await this.cli.assertCleanMerge();
    const [row] = await this.cli.rows(`SELECT m.id, m.fingerprint, m.payload,
      r.state, a.actor FROM memories m
      LEFT JOIN retirements r ON r.scope=m.scope AND r.id=m.id
      LEFT JOIN approvals a ON a.scope=m.scope AND a.id=m.id AND a.fingerprint=m.fingerprint
      WHERE m.scope=${literal(this.scope)} AND m.id=${literal(id)}`);
    if (!row) return undefined;
    return this.decode(row);
  }

  private decode(row: Record<string, unknown>): StoredMemory {
    const id = text(row, 'id');
    const payload = text(row, 'payload');
    const request = requestFromJson(payload);
    if (request.metadata?.project !== this.scope || request.metadata.memoryId !== id
      || createHash('sha256').update(payload).digest('hex') !== text(row, 'fingerprint')) {
      throw new Error('Stored scope/id mismatch');
    }
    const state = row.state;
    if (state !== null && state !== undefined && state !== 'deleted' && state !== 'superseded') {
      throw new Error('Invalid lifecycle state');
    }
    return {
      id: text(row, 'id'), scope: this.scope, fingerprint: text(row, 'fingerprint'), request,
      status: state === 'deleted' || state === 'superseded' ? state : typeof row.actor === 'string' ? 'accepted' : 'proposed',
      acceptedBy: typeof row.actor === 'string' ? row.actor : undefined,
    };
  }

  inspect(id: string): Promise<StoredMemory | undefined> {
    this.key(id);
    return this.serial(() => this.inspectInternal(id));
  }

  async write(request: CopilotMemoryProviderWriteRequest): Promise<CopilotMemoryProviderWriteResult> {
    if (!request.classification.allowed || !this.supportedClasses.includes(request.classification.class)) {
      throw new Error('Unsupported or disallowed classification');
    }
    if (request.metadata?.project !== this.scope) throw new Error('Exact project scope mismatch or missing');
    const id = request.metadata.memoryId;
    if (!id) throw new Error('Stable metadata.memoryId required for retries');
    const where = this.key(id);
    // Validate runtime input too; canonical key ordering makes metadata-order retries stable.
    const payload = JSON.stringify({
      content: request.content, title: request.title, author: request.author,
      metadata: Object.fromEntries(Object.entries(request.metadata).sort(([a], [b]) => a.localeCompare(b))),
      classification: {
        class: request.classification.class, allowed: request.classification.allowed,
        reason: request.classification.reason, destination: request.classification.destination,
        loadGuidance: request.classification.loadGuidance,
      },
    });
    if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Memory exceeds sample payload limit');
    requestFromJson(payload);
    const fingerprint = createHash('sha256').update(payload).digest('hex');
    return this.serial(async () => {
      await this.cli.assertCleanMerge();
      const retired = await this.cli.rows(`SELECT state FROM retirements WHERE ${where}`);
      if (retired.length) throw new Error('Memory is permanently retired; use a new reviewed id');
      await this.cli.run('sql', '-q', `INSERT INTO memories VALUES (
        ${literal(this.scope)},${literal(id)},${literal(fingerprint)},${literal(payload)})
        ON DUPLICATE KEY UPDATE fingerprint=VALUES(fingerprint),payload=VALUES(payload)`);
      return { id, path: `dolt-poc:${this.scope}:${id}` };
    });
  }

  /** Caller supplies the exact fingerprint reviewed; SQL merge is never approval. */
  accept(id: string, expectedFingerprint: string, actor: string): Promise<void> {
    const where = this.key(id);
    if (!actor.trim() || actor.length > 128) throw new Error('Reviewer required');
    return this.serial(async () => {
      const record = await this.inspectInternal(id);
      if (!record || record.status === 'deleted' || record.status === 'superseded'
        || record.fingerprint !== expectedFingerprint) throw new Error('Stale approval or retired/missing memory');
      await this.cli.run('sql', '-q', `INSERT IGNORE INTO approvals
        SELECT scope,id,fingerprint,${literal(actor)} FROM memories WHERE ${where}`);
    });
  }

  retire(id: string, state: 'deleted' | 'superseded', actor: string, successor?: string): Promise<boolean> {
    const where = this.key(id);
    if (!actor.trim() || actor.length > 128) throw new Error('Reviewer required');
    if (state === 'superseded' && (!successor || successor === id)) throw new Error('Distinct accepted successor required');
    if (successor) this.key(successor);
    return this.serial(async () => {
      const record = await this.inspectInternal(id);
      if (!record || record.status === 'deleted' || record.status === 'superseded') return false;
      if (state === 'superseded') {
        const next = successor ? await this.inspectInternal(successor) : undefined;
        if (next?.status !== 'accepted') throw new Error('Distinct accepted successor required');
      }
      await this.cli.run('sql', '-q', `INSERT INTO retirements VALUES (
        ${literal(this.scope)},${literal(id)},${literal(state)},${successor ? literal(successor) : 'NULL'},${literal(actor)})`);
      return true;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.retire(id, 'deleted', 'provider-delete');
  }

  search(query: string): Promise<MemoryProviderSearchResult[]> {
    if (Buffer.byteLength(query) > MAX_BYTES) throw new Error('Query exceeds sample limit');
    return this.serial(async () => {
      await this.cli.assertCleanMerge();
      const rows = await this.cli.rows(`SELECT m.id,m.fingerprint,m.payload,r.state,a.actor FROM memories m
        LEFT JOIN retirements r ON r.scope=m.scope AND r.id=m.id
        LEFT JOIN approvals a ON a.scope=m.scope AND a.id=m.id AND a.fingerprint=m.fingerprint
        WHERE m.scope=${literal(this.scope)} ORDER BY m.id LIMIT 101`);
      if (rows.length > 100) throw new Error('Sample retrieval limit exceeded');
      const results: MemoryProviderSearchResult[] = [];
      for (const row of rows) {
        const record = this.decode(row);
        if (record.status !== 'accepted') continue;
        const { title, content, classification } = record.request;
        const guidance: MemoryLoadGuidance = classification.loadGuidance;
        if (guidance === 'ARCHIVE' || guidance === 'NEVER'
          || !`${title}\n${content}`.toLowerCase().includes(query.toLowerCase())) continue;
        results.push({
          id: record.id, title, snippet: content.slice(0, 240),
          class: classification.class, loadGuidance: guidance,
          path: `dolt-poc:${this.scope}:${record.id}`,
        });
      }
      return results;
    });
  }
}
