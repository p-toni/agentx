import Fastify, { type FastifyInstance } from 'fastify';
import { Journal } from '@deterministic-agent-lab/journal';

export interface GateApiOptions {
  readonly journal?: Journal;
}

export function buildServer(options: GateApiOptions = {}): FastifyInstance {
  const fastify = Fastify();
  const journal = options.journal ?? new Journal();

  fastify.post('/plan', async (request, reply) => {
    const body = (request.body as { id: string; payload: unknown }) ?? {};
    if (!body.id) {
      reply.code(400);
      return { error: 'id is required' };
    }

    journal.add({
      id: body.id,
      timestamp: Date.now(),
      type: 'plan',
      payload: body.payload as Record<string, unknown>
    });

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
