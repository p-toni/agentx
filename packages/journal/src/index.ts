import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TextEncoder } from 'node:util';
import {
  PromptMessage,
  PromptParams,
  PromptRecording,
  PromptTokenEvent,
  PromptTraceStore
} from '@deterministic-agent-lab/trace';
import {
  type HttpRollbackRegistry,
  type HttpRollbackRuleMatch,
  type ResolvedHttpRollback
} from './http-rollback-registry';

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
  readonly previousHash?: string | null;
}

interface FileWritePrepared {
  readonly absolutePath: string;
  readonly previousContent: Uint8Array | null;
  readonly previousMode?: number;
  readonly existed: boolean;
  readonly previousHash?: string;
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

      const previousBuffer = await fs.readFile(absolutePath);
      const previousBase64 = previousBuffer.toString('base64');
      return {
        absolutePath,
        previousContent: new Uint8Array(previousBuffer),
        previousMode: stats.mode,
        existed: true,
        previousHash: createHash('sha256').update(previousBase64, 'utf8').digest('hex')
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          absolutePath,
          previousContent: null,
          existed: false,
          previousHash: undefined
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
    await fs.writeFile(prepared.absolutePath, contentBuffer);

    if (typeof intent.payload.mode === 'number') {
      await fs.chmod(prepared.absolutePath, intent.payload.mode);
    }

    const sha = createHash('sha256').update(intent.payload.content, 'utf8').digest('hex');
    return {
      path: prepared.absolutePath,
      sha256: sha,
      previousHash: prepared.previousHash ?? null
    };
  }

  async rollback(
    intent: Intent<FileWritePayload, FileWriteReceipt>,
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
    } else {
      console.warn(`Rollback could not restore ${prepared.absolutePath}. Manual remediation required.`);
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
  readonly metadata?: HttpPostResponseMetadata;
}

export interface HttpPostDriverOptions {
  readonly rollbackRegistry?: HttpRollbackRegistry | null;
}

interface HttpPostResponseMetadata {
  readonly rollbackRule?: {
    readonly name: string;
    readonly method: 'DELETE' | 'POST';
    readonly pathTemplate: string;
    readonly path: string;
    readonly url: string;
    readonly id?: string;
    readonly headers?: Record<string, string>;
  };
  readonly resourceId?: string;
  readonly location?: string;
  readonly rollbackMethod?: 'DELETE' | 'POST';
  readonly rollbackPath?: string;
}

interface PreparedRollbackContext {
  readonly match: HttpRollbackRuleMatch;
}

interface HttpPostPrepared {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  idempotencyKey: string;
  rollback?: PreparedRollbackContext;
  metadata?: HttpPostResponseMetadata;
}

export class HttpPostDriver implements Driver<HttpPostPayload, HttpPostReceipt, HttpPostPrepared> {
  private readonly rollbackRegistry: HttpRollbackRegistry | null;

  constructor(options: HttpPostDriverOptions = {}) {
    this.rollbackRegistry = options.rollbackRegistry ?? null;
  }

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

    const existingIdempotency = headers['Idempotency-Key'] ?? headers['idempotency-key'];
    const idempotencyKey = existingIdempotency ?? intent.idempotencyKey;
    headers['Idempotency-Key'] = idempotencyKey;

    const bodyText =
      typeof intent.payload.body === 'string'
        ? intent.payload.body
        : JSON.stringify(intent.payload.body ?? null);

    let bodyJson: unknown;
    if (typeof intent.payload.body === 'string') {
      try {
        bodyJson = JSON.parse(intent.payload.body);
      } catch {
        bodyJson = undefined;
      }
    } else {
      bodyJson = intent.payload.body;
    }

    let rollback: PreparedRollbackContext | undefined;
    if (this.rollbackRegistry) {
      const match = this.rollbackRegistry.findRule({
        method: 'POST',
        url: intent.payload.url,
        headers,
        bodyText,
        bodyJson
      });
      if (match) {
        rollback = { match };
      }
    }

    return {
      url: intent.payload.url,
      headers,
      bodyText,
      idempotencyKey,
      rollback
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
    const idempotencyKey = prepared.idempotencyKey;

    const fallbackMetadata = extractResponseMetadata(response, responseBody);
    let metadata: HttpPostResponseMetadata | undefined = fallbackMetadata;

    if (prepared.rollback) {
      const resolved = prepared.rollback.match.resolve({
        baseUrl: prepared.url,
        responseHeaders: collectHeaders(response.headers),
        responseBodyText: responseBody
      });
      if (resolved) {
        metadata = mergeRollbackMetadata(resolved, fallbackMetadata);
      }
    }

    if (metadata) {
      prepared.metadata = metadata;
    }

    return {
      status: response.status,
      idempotencyKey,
      responseHash,
      metadata
    };
  }

  async rollback(
    intent: Intent<HttpPostPayload, HttpPostReceipt>,
    prepared: HttpPostPrepared,
    _context: DriverContext
  ): Promise<void> {
    void _context;
    const metadata = prepared.metadata;
    if (!metadata) {
      labelIntentRequiresManualReview(intent, 'non-reversible');
      return;
    }

    if (metadata.rollbackRule) {
      const headers: Record<string, string> = {
        'Idempotency-Key': `${prepared.idempotencyKey}-rollback`
      };
      if (metadata.rollbackRule.headers) {
        for (const [key, value] of Object.entries(metadata.rollbackRule.headers)) {
          headers[key] = value;
        }
      }
      try {
        await fetch(metadata.rollbackRule.url, {
          method: metadata.rollbackRule.method,
          headers
        });
        return;
      } catch (error) {
        console.warn(`Rollback attempt for ${metadata.rollbackRule.url} failed: ${(error as Error).message}`);
        labelIntentRequiresManualReview(intent, 'rollback_failed');
        return;
      }
    }

    const target = buildRollbackTarget(prepared.url, metadata);
    if (!target) {
      labelIntentRequiresManualReview(intent, 'non-reversible');
      return;
    }

    const { method, url } = target;
    try {
      await fetch(url, {
        method,
        headers: {
          'Idempotency-Key': `${prepared.idempotencyKey}-rollback`
        }
      });
    } catch (error) {
      console.warn(`Rollback attempt for ${url} failed: ${(error as Error).message}`);
      labelIntentRequiresManualReview(intent, 'rollback_failed');
    }
  }
}

function extractResponseMetadata(response: Response, bodyText: string): HttpPostResponseMetadata | undefined {
  const location = response.headers.get('location') ?? undefined;
  let resourceId: string | undefined;
  let rollbackMethod: 'DELETE' | 'POST' | undefined;
  let rollbackPath: string | undefined;

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const bodyId = typeof parsed.id === 'string' ? parsed.id : undefined;
    const rollback = parsed.rollback as { method?: string; path?: string } | undefined;
    resourceId = bodyId;
    if (rollback?.method === 'POST' && typeof rollback.path === 'string') {
      rollbackMethod = 'POST';
      rollbackPath = rollback.path;
    }
  } catch {
    // ignore JSON parse errors
  }

  if (!location && !resourceId && !rollbackPath) {
    return undefined;
  }

  return {
    location,
    resourceId,
    rollbackMethod,
    rollbackPath
  };
}

function buildRollbackTarget(url: string, metadata: HttpPostResponseMetadata): { method: 'DELETE' | 'POST'; url: string } | null {
  if (metadata.rollbackRule) {
    return { method: metadata.rollbackRule.method, url: metadata.rollbackRule.url };
  }

  if (metadata.rollbackPath) {
    const base = new URL(url);
    const targetUrl = new URL(metadata.rollbackPath, base);
    return { method: metadata.rollbackMethod ?? 'POST', url: targetUrl.toString() };
  }

  if (metadata.location) {
    return { method: 'DELETE', url: metadata.location };
  }

  if (metadata.resourceId) {
    const base = new URL(url);
    base.pathname = new URL(metadata.resourceId, base).pathname;
    return { method: 'DELETE', url: base.toString() };
  }

  return null;
}

function labelIntentRequiresManualReview(intent: Intent<HttpPostPayload, HttpPostReceipt>, reason: string): void {
  console.warn(`Intent ${intent.idempotencyKey} requires manual remediation (${reason}).`);
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function mergeRollbackMetadata(
  resolved: ResolvedHttpRollback,
  fallback: HttpPostResponseMetadata | undefined
): HttpPostResponseMetadata {
  const metadata: HttpPostResponseMetadata = {
    ...fallback,
    rollbackRule: {
      name: resolved.ruleName,
      method: resolved.method,
      pathTemplate: resolved.pathTemplate,
      path: resolved.path,
      url: resolved.url,
      id: resolved.id,
      headers: resolved.headers ? { ...resolved.headers } : undefined
    },
    rollbackMethod: resolved.method,
    rollbackPath: resolved.path
  };

  if (resolved.id) {
    metadata.resourceId = resolved.id;
  }

  return metadata;
}

export interface LlmCallPayload {
  readonly provider: string;
  readonly model: string;
  readonly prompt: {
    readonly type?: 'chat';
    readonly messages: PromptMessage[];
  };
  readonly params?: PromptParams;
  readonly metadata?: Record<string, unknown>;
}

export interface LlmCallReceipt {
  readonly provider: string;
  readonly model: string;
  readonly completion: string;
  readonly tokens: PromptTokenEvent[];
  readonly recordedAt: string;
  readonly source: 'record' | 'replay';
  readonly recordingPath?: string;
}

interface LlmCallPrepared {
  readonly preview: string;
}

export interface LlmProviderRequest {
  readonly model: string;
  readonly messages: PromptMessage[];
  readonly params: PromptParams;
  readonly metadata?: Record<string, unknown>;
}

export interface LlmProviderResult {
  readonly id?: string;
  readonly model: string;
  readonly completion: string;
  readonly finishReason?: string;
  readonly raw?: unknown;
}

export interface LlmProvider {
  call(request: LlmProviderRequest): Promise<LlmProviderResult>;
}

export interface LlmCallDriverOptions {
  readonly provider?: LlmProvider;
  readonly recorder?: PromptTraceStore;
  readonly clock?: () => Date;
  readonly simulate?: (payload: LlmCallPayload) => string;
}

const DEFAULT_SIMULATION_PREFIX = '[simulated]';

export class LlmCallDriver implements Driver<LlmCallPayload, LlmCallReceipt, LlmCallPrepared> {
  private readonly provider: LlmProvider;
  private readonly recorder: PromptTraceStore;
  private readonly clock: () => Date;
  private readonly simulate: (payload: LlmCallPayload) => string;

  constructor(options: LlmCallDriverOptions = {}) {
    this.provider = options.provider ?? new OpenAICompatibleProvider();
    this.recorder = options.recorder ?? PromptTraceStore.fromEnv();
    this.clock = options.clock ?? (() => new Date());
    this.simulate = options.simulate ?? defaultSimulation;
  }

  async prepare(intent: Intent<LlmCallPayload, LlmCallReceipt>, context: DriverContext): Promise<LlmCallPrepared> {
    void context;
    const preview = this.simulate(intent.payload);
    return { preview };
  }

  async commit(
    intent: Intent<LlmCallPayload, LlmCallReceipt>,
    prepared: LlmCallPrepared,
    context: DriverContext
  ): Promise<LlmCallReceipt> {
    void prepared;
    void context;
    const params = normaliseParams(intent.payload.params);
    const mode = this.recorder.getMode();

    if (mode === 'replay') {
      const recording = await this.recorder.consumePrompt();
      return {
        provider: recording.provider,
        model: recording.model,
        completion: recording.response.completion,
        tokens: cloneTokens(recording.response.tokens),
        recordedAt: recording.timings.completedAt,
        source: 'replay'
      };
    }

    const startedAt = this.clock().toISOString();
    const prompt = {
      type: intent.payload.prompt.type ?? 'chat',
      messages: intent.payload.prompt.messages
    } as const;
    const result = await this.provider.call({
      model: intent.payload.model,
      messages: prompt.messages,
      params,
      metadata: intent.payload.metadata
    });

    const completion = result.completion;
    const tokens = createTokenEvents(completion, this.clock);
    const recording: PromptRecording = {
      type: 'llm.call',
      provider: intent.payload.provider,
      model: result.model,
      params,
      prompt,
      response: {
        completion,
        finishReason: result.finishReason,
        tokens
      },
      timings: {
        startedAt,
        completedAt: this.clock().toISOString()
      },
      metadata: createRecordingMetadata(intent, result)
    };

    const recordingPath = await this.recorder.recordPrompt(recording);

    return {
      provider: recording.provider,
      model: recording.model,
      completion: recording.response.completion,
      tokens: cloneTokens(recording.response.tokens),
      recordedAt: recording.timings.completedAt,
      recordingPath,
      source: 'record'
    };
  }

  async rollback(
    intent: Intent<LlmCallPayload, LlmCallReceipt>,
    prepared: LlmCallPrepared,
    context: DriverContext
  ): Promise<void> {
    void intent;
    void prepared;
    void context;
    // LLM calls are not rolled back; deterministic replay handles compensation.
  }
}

export interface OpenAICompatibleProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly fetchImpl?: typeof fetch;
}

interface OpenAIChatCompletionResponseChoice {
  index: number;
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string;
  };
}

interface OpenAIChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChatCompletionResponseChoice[];
  [key: string]: unknown;
}

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly organization?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
    this.organization = options.organization ?? process.env.OPENAI_ORGANIZATION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Global fetch implementation is required for OpenAICompatibleProvider');
    }
  }

  async call(request: LlmProviderRequest): Promise<LlmProviderResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.params.temperature,
        top_p: request.params.top_p,
        stream: false
      })
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`OpenAI request failed with status ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as OpenAIChatCompletionResponse;
    const firstChoice = payload.choices?.[0];
    const completion = firstChoice?.message?.content ?? '';

    return {
      id: payload.id,
      model: payload.model ?? request.model,
      completion,
      finishReason: firstChoice?.finish_reason,
      raw: payload
    };
  }
}

function defaultSimulation(payload: LlmCallPayload): string {
  const lastMessage = payload.prompt.messages.at(-1);
  const suffix = lastMessage ? ` ${lastMessage.content}` : '';
  return `${DEFAULT_SIMULATION_PREFIX}${suffix}`.trim();
}

function normaliseParams(params?: PromptParams): PromptParams {
  if (!params) {
    return {};
  }

  const safeParams: PromptParams = {};
  if (typeof params.temperature === 'number') {
    safeParams.temperature = params.temperature;
  }
  if (typeof params.top_p === 'number') {
    safeParams.top_p = params.top_p;
  }

  for (const [key, value] of Object.entries(params)) {
    if (key === 'temperature' || key === 'top_p') {
      continue;
    }
    safeParams[key] = value;
  }

  return safeParams;
}

function createTokenEvents(content: string, clock: () => Date): PromptTokenEvent[] {
  const glyphs = Array.from(content);
  return glyphs.map((token, index) => ({
    index,
    token,
    timestamp: clock().toISOString()
  }));
}

function cloneTokens(tokens: PromptTokenEvent[]): PromptTokenEvent[] {
  return tokens.map((token) => ({ ...token }));
}

function createRecordingMetadata(
  intent: Intent<LlmCallPayload, LlmCallReceipt>,
  result: LlmProviderResult
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    intentIdempotencyKey: intent.idempotencyKey,
    ...(intent.metadata ?? {})
  };

  if (result.id) {
    metadata.providerResponseId = result.id;
  }

  if (Object.keys(metadata).length === 0) {
    return undefined;
  }

  return metadata;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unavailable>';
  }
}

export {
  createHttpRollbackRegistry,
  loadHttpRollbackRegistrySync,
  tryLoadHttpRollbackRegistrySync
} from './http-rollback-registry';

export type {
  HttpRollbackRegistryConfig,
  HttpRollbackRuleConfig,
  HttpRollbackJsonMatcher,
  HttpRollbackRegistry,
  HttpRollbackRuleMatch,
  ResolvedHttpRollback
} from './http-rollback-registry';
