import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { Journal, type Driver, type Intent } from '@deterministic-agent-lab/journal';
import { FileWriteDriver, HttpPostDriver, LlmCallDriver } from '@deterministic-agent-lab/journal';
import { GateStore, generateIntentId } from './store';
import { loadPlanSummary, type LoadedIntent } from './bundle';
import { evaluatePolicy, loadPolicy, type PolicyEvaluation } from './policy';

export interface GateApiOptions {
  readonly dataDir?: string;
  readonly policyPath: string;
  readonly drivers?: Record<string, DriverFactory>;
  readonly journal?: Journal;
  readonly clock?: () => Date;
}

export type DriverFactory = (intent: LoadedIntent) => Driver<unknown, unknown, unknown>;

export interface PlanResponse {
  readonly bundleId: string;
  readonly createdAt: string;
  readonly intents: Array<PlanIntentSummary>;
  readonly fsDiff: { changed: string[]; deleted: string[] };
  readonly network: PolicyEvaluation['network'];
  readonly policy: PolicyEvaluation;
  readonly approval?: { actor: string; policyVersion: string; approvedAt: string } | null;
}

export interface PlanIntentSummary {
  readonly id: string;
  readonly type: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export function buildServer(options: GateApiOptions): FastifyInstance {
  const fastify = Fastify();
  const dataDir = options.dataDir ?? path.join(process.cwd(), '.gate');
  const store = new GateStore(dataDir);
  const journal = options.journal ?? new Journal({ filePath: path.join(dataDir, 'journal.jsonl') });
  const driverRegistry = options.drivers ?? createDefaultDriverRegistry();
  const clock = options.clock ?? (() => new Date());
  const policyPath = options.policyPath;

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
    const intents = attachIntentIds(bundleId, plan.intents);
    const policy = await loadPolicy(policyPath);
    const evaluation = evaluatePolicy(policy, plan.intents, plan.network);
    const approval = store.getApproval(bundleId) ?? null;

    const response: PlanResponse = {
      bundleId,
      createdAt: bundle.createdAt,
      intents: intents.map((intent) => ({
        id: intent.id,
        type: intent.type,
        timestamp: intent.timestamp,
        payload: intent.payload,
        metadata: intent.metadata
      })),
      fsDiff: plan.fsDiff,
      network: evaluation.network,
      policy: evaluation,
      approval
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
    const intents = attachIntentIds(bundleId, plan.intents);
    const policy = await loadPolicy(policyPath);
    const evaluation = evaluatePolicy(policy, plan.intents, plan.network);

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
      const driver = resolveDriver(driverRegistry, intent);
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
    const intents = attachIntentIds(bundleId, plan.intents);
    const intentsById = new Map(intents.map((intent) => [intent.id, intent]));

    for (const record of receipts) {
      const intent = intentsById.get(record.intentId);
      if (!intent) {
        continue;
      }
      const driver = resolveDriver(driverRegistry, intent);
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

function resolveDriver(registry: Record<string, DriverFactory>, intent: LoadedIntent): Driver<unknown, unknown, unknown> {
  const factory = registry[intent.type];
  if (factory) {
    return factory(intent);
  }
  const fallback = createDefaultDriver(intent.type);
  if (!fallback) {
    throw new Error(`No driver registered for intent type ${intent.type}`);
  }
  return fallback;
}

function createDefaultDriverRegistry(): Record<string, DriverFactory> {
  return {
    'files.write': () => new FileWriteDriver(),
    'http.post': () => new HttpPostDriver(),
    'llm.call': () => new LlmCallDriver()
  };
}

function createDefaultDriver(type: string): Driver<unknown, unknown, unknown> | undefined {
  switch (type) {
    case 'files.write':
      return new FileWriteDriver();
    case 'http.post':
      return new HttpPostDriver();
    case 'llm.call':
      return new LlmCallDriver();
    default:
      return undefined;
  }
}

if (require.main === module) {
  const policyPath = process.env.GATE_POLICY ?? path.join(process.cwd(), 'policy.yaml');
  const dataDir = process.env.GATE_DATA_DIR ?? path.join(process.cwd(), '.gate');
  const server = buildServer({ policyPath, dataDir });
  server.listen({ port: 3000, host: '0.0.0.0' }).catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
}
