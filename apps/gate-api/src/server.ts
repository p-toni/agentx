import Fastify, { type FastifyInstance } from 'fastify';
import type { Driver, Intent } from '@deterministic-agent-lab/journal';
import { Journal } from '@deterministic-agent-lab/journal';

export interface GateApiOptions {
  readonly journal?: Journal;
}

export function buildServer(options: GateApiOptions = {}): FastifyInstance {
  const fastify = Fastify();
  const journal = options.journal ?? new Journal();
  const planDriver = new PlanIntentDriver();

  fastify.post('/plan', async (request, reply) => {
    const body = (request.body as { id: string; payload: unknown }) ?? {};
    if (!body.id) {
      reply.code(400);
      return { error: 'id is required' };
    }

    await journal.append(
      {
        type: 'plan',
        idempotencyKey: body.id,
        payload: {
          id: body.id,
          data: body.payload
        }
      },
      planDriver
    );

    return { status: 'accepted' };
  });

  return fastify;
}

if (require.main === module) {
  const server = buildServer();
  server.listen({ port: 3000, host: '0.0.0.0' }).catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
}

interface PlanPayload {
  readonly id: string;
  readonly data: unknown;
}

interface PlanReceipt {
  readonly acknowledged: true;
}

class PlanIntentDriver implements Driver<PlanPayload, PlanReceipt, void> {
  async plan(intent: Intent<PlanPayload, PlanReceipt>): Promise<void> {
    if (!intent.payload.id) {
      throw new Error('plan intent requires an id');
    }
  }

  async prepare(): Promise<void> {
    return undefined;
  }

  async commit(): Promise<PlanReceipt> {
    return { acknowledged: true } as const;
  }

  async rollback(): Promise<void> {
    // Nothing to rollback; persistence is handled by the journal entry itself.
  }
}
