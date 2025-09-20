import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';

describe('gate-api server', () => {
  it('records plans via POST /plan', async () => {
    const server = buildServer();

    const response = await server.inject({
      method: 'POST',
      url: '/plan',
      payload: { id: 'plan-1', payload: { tasks: 2 } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'accepted' });

    await server.close();
  });
});
