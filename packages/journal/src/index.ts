import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TextEncoder } from 'node:util';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface Intent<TPayload, TReceipt> {
  readonly type: string;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly metadata?: Record<string, unknown>;
}

export interface Driver<TPayload, TReceipt, TPrepared = void> {
  plan?(intent: Intent<TPayload, TReceipt>, context: DriverContext): Promise<void> | void;
  validate?(intent: Intent<TPayload, TReceipt>, context: DriverContext): Promise<void> | void;
  prepare(intent: Intent<TPayload, TReceipt>, context: DriverContext): Promise<TPrepared> | TPrepared;
  commit(
    intent: Intent<TPayload, TReceipt>,
    prepared: TPrepared,
    context: DriverContext
  ): Promise<TReceipt> | TReceipt;
  rollback(
    intent: Intent<TPayload, TReceipt>,
    prepared: TPrepared,
    context: DriverContext
  ): Promise<void> | void;
}

export interface DriverContext {
  readonly journal: Journal;
}

export type JournalEntryStatus = 'committed' | 'rolledback';

export interface JournalEntry<TPayload = unknown, TReceipt = unknown> {
  readonly id: string;
  readonly intentType: string;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly receipt?: TReceipt;
  readonly timestamp: string;
  readonly status: JournalEntryStatus;
  readonly metadata?: Record<string, unknown>;
  readonly error?: string;
}

export interface JournalOptions {
  readonly filePath?: string;
  readonly clock?: () => Date;
}

const ID_WIDTH = 12;
const textEncoder = new TextEncoder();

export class Journal {
  private readonly filePath: string;
  private readonly clock: () => Date;
  private readonly entries: JournalEntry[] = [];
  private readonly entriesByIdempotency = new Map<string, JournalEntry>();
  private nextSequence: number = 1;

  constructor(options: JournalOptions = {}) {
    this.filePath = resolve(options.filePath ?? join(process.cwd(), 'intents.jsonl'));
    this.clock = options.clock ?? (() => new Date());

    if (existsSync(this.filePath)) {
      const raw = readFileSync(this.filePath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        try {
          const entry = JSON.parse(line) as JournalEntry;
          this.entries.push(entry);
          if (entry.status === 'committed') {
            this.entriesByIdempotency.set(entry.idempotencyKey, entry);
          }
        } catch (error) {
          throw new Error(`Failed to parse journal entry: ${(error as Error).message}`);
        }
      }

      const lastEntry = this.entries.at(-1);
      if (lastEntry) {
        const numeric = Number.parseInt(lastEntry.id, 10);
        if (!Number.isNaN(numeric)) {
          this.nextSequence = numeric + 1;
        }
      }
    }
  }

  list(): readonly JournalEntry[] {
    return [...this.entries];
  }

  async append<TPayload, TReceipt, TPrepared>(
    intent: Intent<TPayload, TReceipt>,
    driver: Driver<TPayload, TReceipt, TPrepared>
  ): Promise<JournalEntry<TPayload, TReceipt>> {
    const existing = this.entriesByIdempotency.get(intent.idempotencyKey);
    if (existing) {
      return existing as JournalEntry<TPayload, TReceipt>;
    }

    const context: DriverContext = { journal: this };

    if (driver.plan) {
      await driver.plan(intent, context);
    }
    if (driver.validate) {
      await driver.validate(intent, context);
    }

    let prepared: TPrepared | undefined;
    let prepareCompleted = false;

    try {
      prepared = await driver.prepare(intent, context);
      prepareCompleted = true;
      const receipt = await driver.commit(intent, prepared, context);
      const entry = this.createEntry(intent, 'committed', receipt);
      await this.persistEntry(entry);
      return entry;
    } catch (error) {
      if (prepareCompleted) {
        try {
          await driver.rollback(intent, prepared as TPrepared, context);
        } catch {
          // Ignore rollback failures; original error is more important.
        }
      }

      const failureEntry = this.createEntry(intent, 'rolledback', undefined, serialiseError(error));
      await this.persistEntry(failureEntry);
      throw error;
    }
  }

  private createEntry<TPayload, TReceipt>(
    intent: Intent<TPayload, TReceipt>,
    status: JournalEntryStatus,
    receipt?: TReceipt,
    error?: string
  ): JournalEntry<TPayload, TReceipt> {
    const entry: JournalEntry<TPayload, TReceipt> = {
      id: formatId(this.nextSequence++),
      intentType: intent.type,
      idempotencyKey: intent.idempotencyKey,
      payload: intent.payload,
      receipt,
      timestamp: this.clock().toISOString(),
      status,
      metadata: intent.metadata,
      error
    };

    return entry;
  }

  private async persistEntry(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
    if (entry.status === 'committed') {
      this.entriesByIdempotency.set(entry.idempotencyKey, entry);
    }

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function formatId(id: number): string {
  return id.toString().padStart(ID_WIDTH, '0');
}

function serialiseError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export interface FileWritePayload {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

export interface FileWriteReceipt {
  readonly path: string;
  readonly sha256: string;
}

interface FileWritePrepared {
  readonly absolutePath: string;
  readonly previousContent: Uint8Array | null;
  readonly previousMode?: number;
  readonly existed: boolean;
}

export class FileWriteDriver implements Driver<FileWritePayload, FileWriteReceipt, FileWritePrepared> {
  async plan(intent: Intent<FileWritePayload, FileWriteReceipt>): Promise<void> {
    if (!intent.payload.path) {
      throw new Error('files.write requires a path');
    }
  }

  async validate(intent: Intent<FileWritePayload, FileWriteReceipt>): Promise<void> {
    if (typeof intent.payload.content !== 'string') {
      throw new Error('files.write content must be a string');
    }
  }

  async prepare(intent: Intent<FileWritePayload, FileWriteReceipt>): Promise<FileWritePrepared> {
    const absolutePath = resolve(intent.payload.path);
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        throw new Error(`Cannot write non-file path: ${intent.payload.path}`);
      }

      const previousContent = new Uint8Array(await fs.readFile(absolutePath));
      return {
        absolutePath,
        previousContent,
        previousMode: stats.mode,
        existed: true
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          absolutePath,
          previousContent: null,
          existed: false
        };
      }

      throw error;
    }
  }

  async commit(
    intent: Intent<FileWritePayload, FileWriteReceipt>,
    prepared: FileWritePrepared
  ): Promise<FileWriteReceipt> {
    const contentBuffer = textEncoder.encode(intent.payload.content);
    await fs.mkdir(dirname(prepared.absolutePath), { recursive: true });
    await fs.writeFile(prepared.absolutePath, contentBuffer, {
      mode: intent.payload.mode
    });

    if (typeof intent.payload.mode === 'number') {
      await fs.chmod(prepared.absolutePath, intent.payload.mode);
    }

    return {
      path: prepared.absolutePath,
      sha256: createHash('sha256').update(contentBuffer).digest('hex')
    };
  }

  async rollback(
    _intent: Intent<FileWritePayload, FileWriteReceipt>,
    prepared: FileWritePrepared
  ): Promise<void> {
    if (prepared.existed && prepared.previousContent) {
      await fs.mkdir(dirname(prepared.absolutePath), { recursive: true });
      await fs.writeFile(prepared.absolutePath, prepared.previousContent);
      if (typeof prepared.previousMode === 'number') {
        await fs.chmod(prepared.absolutePath, prepared.previousMode);
      }
    } else if (!prepared.existed) {
      await fs.rm(prepared.absolutePath, { force: true });
    }
  }
}

export interface HttpPostPayload {
  readonly url: string;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export interface HttpPostReceipt {
  readonly status: number;
  readonly idempotencyKey: string;
  readonly responseHash: string;
}

interface HttpPostPrepared {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

export class HttpPostDriver implements Driver<HttpPostPayload, HttpPostReceipt, HttpPostPrepared> {
  async plan(intent: Intent<HttpPostPayload, HttpPostReceipt>): Promise<void> {
    if (!intent.payload.url) {
      throw new Error('http.post requires a url');
    }
  }

  async validate(intent: Intent<HttpPostPayload, HttpPostReceipt>): Promise<void> {
    const url = new URL(intent.payload.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported protocol for http.post: ${url.protocol}`);
    }
  }

  async prepare(intent: Intent<HttpPostPayload, HttpPostReceipt>): Promise<HttpPostPrepared> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(intent.payload.headers ?? {})
    };

    if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
      headers['Idempotency-Key'] = intent.idempotencyKey;
    }

    const bodyText =
      typeof intent.payload.body === 'string'
        ? intent.payload.body
        : JSON.stringify(intent.payload.body ?? null);

    return {
      url: intent.payload.url,
      headers,
      bodyText
    };
  }

  async commit(
    intent: Intent<HttpPostPayload, HttpPostReceipt>,
    prepared: HttpPostPrepared
  ): Promise<HttpPostReceipt> {
    const response = await fetch(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.bodyText
    });

    const responseBody = await response.text();
    const responseHash = createHash('sha256').update(responseBody).digest('hex');
    const idempotencyKey =
      prepared.headers['Idempotency-Key'] ?? prepared.headers['idempotency-key'] ?? intent.idempotencyKey;

    return {
      status: response.status,
      idempotencyKey,
      responseHash
    };
  }

  async rollback(): Promise<void> {
    // Intentionally a no-op. Future implementations may enqueue compensating actions.
  }
}
