import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import {
  Journal,
  FileWriteDriver,
  HttpPostDriver,
  LlmCallDriver,
  createHttpRollbackRegistry,
  tryLoadHttpRollbackRegistrySync,
  type Driver,
  type Intent,
  type HttpRollbackRegistry,
  type HttpPostPayload
} from '@deterministic-agent-lab/journal';
import { GateStore, generateIntentId, type ApprovalRecord } from './store';
import { loadPlanSummary, type LoadedIntent, type FileDiffSummary, type PromptRecord } from './bundle';
import { loadPolicy, type PolicyEvaluation } from './policy';

export interface GateApiOptions {
  readonly dataDir?: string;
  readonly policyPath: string;
  readonly drivers?: Record<string, DriverFactory>;
  readonly journal?: Journal;
  readonly clock?: () => Date;
  readonly httpRollbackRegistry?: HttpRollbackRegistry;
}

export type DriverFactory = (intent: LoadedIntent) => Driver<unknown, unknown, unknown>;

export interface BundleSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly status: BundleStatus;
  readonly approval?: { actor: string; policyVersion: string; approvedAt: string } | null;
}

export type BundleStatus = 'pending' | 'approved' | 'committed';

export interface PlanResponse {
  readonly bundleId: string;
  readonly createdAt: string;
  readonly intents: Array<PlanIntentSummary>;
  readonly fsDiff: FileDiffSummary;
  readonly network: PolicyEvaluation['network'];
  readonly networkHar?: string | null;
  readonly policy: PolicyEvaluation;
  readonly approval?: { actor: string; policyVersion: string; approvedAt: string } | null;
  readonly prompts: PromptRecord[];
  readonly status: BundleStatus;
}

export interface PlanIntentSummary {
  readonly id: string;
  readonly type: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly rollback?: PlanRollbackSummary;
}

export interface PlanRollbackSummary {
  readonly available: boolean;
  readonly rule?: string;
  readonly method?: 'DELETE' | 'POST';
  readonly pathTemplate?: string;
  readonly requiresId?: boolean;
  readonly idSources?: string[];
}

export function buildServer(options: GateApiOptions): FastifyInstance {
  const fastify = Fastify();
  fastify.register(cors, { origin: true });
  const dataDir = options.dataDir ?? path.join(process.cwd(), '.gate');
  const store = new GateStore(dataDir);
  const journal = options.journal ?? new Journal({ filePath: path.join(dataDir, 'journal.jsonl') });
  const clock = options.clock ?? (() => new Date());
  const policyPath = options.policyPath;
  const rollbackRegistry = options.httpRollbackRegistry ?? loadHttpRollbackRegistry(policyPath);
  const driverRegistry = options.drivers ?? createDefaultDriverRegistry(rollbackRegistry);

  fastify.get('/bundles', async () => {
    const bundles = store.listBundles();
    return {
      bundles: bundles.map((bundle) => {
        const approval = store.getApproval(bundle.id) ?? null;
        const status = determineStatus(store, bundle.id, approval);
        return {
          id: bundle.id,
          createdAt: bundle.createdAt,
          status,
          approval
        } satisfies BundleSummary;
      })
    };
  });

  fastify.post('/bundles', async (request, reply) => {
    const payload = await extractBundleBuffer(request.body);
    if (!payload) {
      reply.code(400);
      return { error: 'bundle payload is required' };
    }

    const bundleId = randomUUID();
    await store.persistBundle(bundleId, payload);
    reply.code(201);
    return { bundleId };
  });

  fastify.get('/bundles/:id/plan', async (request, reply) => {
    const bundleId = (request.params as { id: string }).id;
    const bundle = store.getBundle(bundleId);
    if (!bundle) {
      reply.code(404);
      return { error: 'bundle not found' };
    }

    const plan = await loadPlanSummary(bundle.path);
    const baseIntents = applyDefaultIntentMetadata(plan.intents);
    const intents = attachIntentIds(bundleId, baseIntents);
    const policy = await loadPolicy(policyPath);
    const evaluation = policy.evaluate({ stage: 'plan', now: clock() }, baseIntents, plan.network);
    const approval = store.getApproval(bundleId) ?? null;
    const status = determineStatus(store, bundleId, approval);

    const intentSummaries = intents.map((intent) => ({
      id: intent.id,
      type: intent.type,
      timestamp: intent.timestamp,
      payload: intent.payload,
      metadata: intent.metadata,
      rollback: describeRollbackIntent(intent, rollbackRegistry)
    }));

    const response: PlanResponse = {
      bundleId,
      createdAt: bundle.createdAt,
      intents: intentSummaries,
      fsDiff: plan.fsDiff,
      network: evaluation.network,
      networkHar: plan.networkHar,
      policy: evaluation,
      approval,
      prompts: plan.prompts,
      status
    };

    return response;
  });

  fastify.post('/bundles/:id/approve', async (request, reply) => {
    const bundleId = (request.params as { id: string }).id;
    const bundle = store.getBundle(bundleId);
    if (!bundle) {
      reply.code(404);
      return { error: 'bundle not found' };
    }

    const body = (request.body ?? {}) as { actor?: string; policyVersion?: string };
    if (!body.actor) {
      reply.code(400);
      return { error: 'actor is required' };
    }

    const policy = await loadPolicy(policyPath);
    const approvalRecord = {
      bundleId,
      actor: body.actor,
      policyVersion: body.policyVersion ?? policy.version,
      approvedAt: clock().toISOString()
    };
    store.recordApproval(approvalRecord);

    return { status: 'approved', bundleId, approval: approvalRecord };
  });

  fastify.post('/bundles/:id/commit', async (request, reply) => {
    const bundleId = (request.params as { id: string }).id;
    const bundle = store.getBundle(bundleId);
    if (!bundle) {
      reply.code(404);
      return { error: 'bundle not found' };
    }

    const plan = await loadPlanSummary(bundle.path);
    const baseIntents = applyDefaultIntentMetadata(plan.intents);
    const intents = attachIntentIds(bundleId, baseIntents);
    const policy = await loadPolicy(policyPath);
    const evaluation = policy.evaluate({ stage: 'commit', now: clock() }, baseIntents, plan.network);

    if (!evaluation.allowed) {
      reply.code(403);
      return { error: 'policy check failed', reasons: evaluation.reasons };
    }

    const approval = store.getApproval(bundleId);
    if (evaluation.requiresApproval) {
      if (!approval || approval.policyVersion !== policy.version) {
        reply.code(403);
        return { error: 'bundle requires approval before commit' };
      }
    }

    const receipts: Array<{ intentId: string; receipt: unknown }> = [];

    for (const intent of intents) {
      const driver = resolveDriver(driverRegistry, intent, rollbackRegistry);
      const journalIntent = toJournalIntent(bundleId, intent);
      const context = { journal };
      if (typeof driver.plan === 'function') {
        await driver.plan(journalIntent as Intent<unknown, unknown>, context);
      }
      if (typeof driver.validate === 'function') {
        await driver.validate(journalIntent as Intent<unknown, unknown>, context);
      }
      const prepared = await driver.prepare(journalIntent as Intent<unknown, unknown>, context);
      const receipt = await driver.commit(journalIntent as Intent<unknown, unknown>, prepared, context);
      receipts.push({ intentId: intent.id, receipt });
      store.saveReceipt({
        bundleId,
        intentId: intent.id,
        intentType: intent.type,
        receipt,
        recordedAt: clock().toISOString()
      });
    }

    return { status: 'committed', bundleId, receipts };
  });

  fastify.post('/bundles/:id/revert', async (request, reply) => {
    const bundleId = (request.params as { id: string }).id;
    const bundle = store.getBundle(bundleId);
    if (!bundle) {
      reply.code(404);
      return { error: 'bundle not found' };
    }

    const receipts = store.listReceipts(bundleId);
    if (receipts.length === 0) {
      reply.code(400);
      return { error: 'no receipts available for bundle' };
    }

    const plan = await loadPlanSummary(bundle.path);
    const baseIntents = applyDefaultIntentMetadata(plan.intents);
    const intents = attachIntentIds(bundleId, baseIntents);
    const intentsById = new Map(intents.map((intent) => [intent.id, intent]));

    for (const record of receipts) {
      const intent = intentsById.get(record.intentId);
      if (!intent) {
        continue;
      }
      const driver = resolveDriver(driverRegistry, intent, rollbackRegistry);
      const journalIntent = toJournalIntent(bundleId, intent);
      const context = { journal };
      if (typeof driver.rollback === 'function') {
        await driver.rollback(journalIntent as Intent<unknown, unknown>, record.receipt, context);
      }
    }

    return { status: 'reverted', bundleId };
  });

  return fastify;
}

async function extractBundleBuffer(body: unknown): Promise<Uint8Array | null> {
  if (!body) {
    return null;
  }
  if (Buffer.isBuffer(body)) {
    return bufferToUint8Array(body);
  }
  if (typeof body === 'object') {
    const maybe = body as { bundle?: string };
    if (maybe.bundle && typeof maybe.bundle === 'string') {
      return bufferToUint8Array(Buffer.from(maybe.bundle, 'base64'));
    }
  }
  if (typeof body === 'string') {
    return bufferToUint8Array(Buffer.from(body, 'base64'));
  }
  return null;
}

function bufferToUint8Array(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

interface IntentWithId extends LoadedIntent {
  readonly id: string;
}

function attachIntentIds(bundleId: string, intents: LoadedIntent[]): IntentWithId[] {
  return intents.map((intent) => {
    const payload = intent.payload as Record<string, unknown> | undefined;
    const metadata = intent.metadata ?? {};
    const rawId = (metadata.id as string | undefined) ?? (payload?.id as string | undefined);
    const id = generateIntentId(intent.type, intent.index, rawId);
    return { ...intent, id };
  });
}

function toJournalIntent(bundleId: string, intent: IntentWithId): Intent<unknown, unknown> {
  return {
    type: intent.type,
    idempotencyKey: `${bundleId}:${intent.id}`,
    payload: intent.payload ?? {},
    metadata: {
      ...(intent.metadata ?? {}),
      timestamp: intent.timestamp,
      intentId: intent.id
    }
  };
}

function determineStatus(store: GateStore, bundleId: string, approval: ApprovalRecord | null): BundleStatus {
  if (store.hasReceipts(bundleId)) {
    return 'committed';
  }
  if (approval) {
    return 'approved';
  }
  return 'pending';
}

function resolveDriver(
  registry: Record<string, DriverFactory>,
  intent: LoadedIntent,
  rollbackRegistry: HttpRollbackRegistry | null
): Driver<unknown, unknown, unknown> {
  const factory = registry[intent.type];
  if (factory) {
    return factory(intent);
  }
  const fallback = createDefaultDriver(intent.type, rollbackRegistry);
  if (!fallback) {
    throw new Error(`No driver registered for intent type ${intent.type}`);
  }
  return fallback;
}

function createDefaultDriverRegistry(rollbackRegistry: HttpRollbackRegistry | null): Record<string, DriverFactory> {
  return {
    'files.write': () => new FileWriteDriver(),
    'http.post': () => new HttpPostDriver({ rollbackRegistry }),
    'llm.call': () => new LlmCallDriver(),
    'email.send': () => new EmailSendDriver(),
    'calendar.event': () => new CalendarEventDriver()
  };
}

function createDefaultDriver(
  type: string,
  rollbackRegistry: HttpRollbackRegistry | null
): Driver<unknown, unknown, unknown> | undefined {
  switch (type) {
    case 'files.write':
      return new FileWriteDriver();
    case 'http.post':
      return new HttpPostDriver({ rollbackRegistry });
    case 'llm.call':
      return new LlmCallDriver();
    case 'email.send':
      return new EmailSendDriver();
    case 'calendar.event':
      return new CalendarEventDriver();
    default:
      return undefined;
  }
}

function describeRollbackIntent(
  intent: LoadedIntent,
  registry: HttpRollbackRegistry | null
): PlanRollbackSummary | undefined {
  if (!registry || intent.type !== 'http.post') {
    return intent.type === 'http.post' ? { available: false } : undefined;
  }

  const payload = intent.payload as HttpPostPayload | undefined;
  if (!payload || typeof payload.url !== 'string') {
    return { available: false };
  }

  const headers = {
    'content-type': 'application/json',
    ...(payload.headers ?? {})
  };

  const bodyText =
    typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body ?? null);

  let bodyJson: unknown;
  if (typeof payload.body === 'string') {
    try {
      bodyJson = JSON.parse(payload.body);
    } catch {
      bodyJson = undefined;
    }
  } else {
    bodyJson = payload.body;
  }

  const match = registry.findRule({
    method: 'POST',
    url: payload.url,
    headers,
    bodyText,
    bodyJson
  });

  if (!match) {
    return { available: false };
  }

  return {
    available: true,
    rule: match.name,
    method: match.method,
    pathTemplate: match.pathTemplate,
    requiresId: match.requiresId,
    idSources: match.idSources.length > 0 ? match.idSources : undefined
  } satisfies PlanRollbackSummary;
}

function applyDefaultIntentMetadata(intents: LoadedIntent[]): LoadedIntent[] {
  return intents.map((intent) => {
    const label = defaultLabelForIntent(intent.type);
    if (!label) {
      return intent;
    }

    const metadata = { ...(intent.metadata ?? {}) } as Record<string, unknown>;
    const labels = ensureLabels(metadata.labels, label);

    return {
      ...intent,
      metadata: {
        ...metadata,
        labels
      },
      raw: {
        ...intent.raw,
        metadata: {
          ...(intent.raw.metadata as Record<string, unknown> | undefined ?? {}),
          labels
        }
      }
    } satisfies LoadedIntent;
  });
}

function ensureLabels(existing: unknown, required: string): string[] {
  const set = new Set<string>();
  toStringArray(existing).forEach((value) => set.add(value));
  set.add(required);
  return Array.from(set.values()).sort();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function defaultLabelForIntent(type: string): string | null {
  switch (type) {
    case 'email.send':
      return 'external_email';
    case 'calendar.event':
      return 'calendar';
    default:
      return null;
  }
}

function loadHttpRollbackRegistry(policyPath: string): HttpRollbackRegistry {
  const policyDir = resolvePolicyDirectory(policyPath);
  const candidates = ['http-rollback.yaml', 'http-rollback.yml', 'http-rollback.json'];
  for (const candidate of candidates) {
    const attempt = tryLoadHttpRollbackRegistrySync(path.join(policyDir, candidate));
    if (attempt) {
      return attempt;
    }
  }
  return createHttpRollbackRegistry(null);
}

function resolvePolicyDirectory(policyPath: string): string {
  const extension = path.extname(policyPath).toLowerCase();
  if (extension === '.wasm' || extension === '.json') {
    return path.dirname(policyPath);
  }
  return policyPath;
}

if (require.main === module) {
  const policyPath = process.env.GATE_POLICY ?? path.join(process.cwd(), 'policy');
  const dataDir = process.env.GATE_DATA_DIR ?? path.join(process.cwd(), '.gate');
  const server = buildServer({ policyPath, dataDir });
  server.listen({ port: 3000, host: '0.0.0.0' }).catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
}
