import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '@deterministic-agent-lab/journal';
import { buildServer } from '../src/server';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

describe('gate-api server', () => {
  it('records plans via POST /plan', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gate-api-'));
    cleanup.push(workspace);
    const journal = new Journal({ filePath: join(workspace, 'intents.jsonl') });
    const server = buildServer({ journal });

    const response = await server.inject({
      method: 'POST',
      url: '/plan',
      payload: { id: 'plan-1', payload: { tasks: 2 } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'accepted' });
    expect(journal.list()).toHaveLength(1);
    expect(journal.list()[0]?.payload).toEqual({ id: 'plan-1', data: { tasks: 2 } });

    await server.close();
  });
});
