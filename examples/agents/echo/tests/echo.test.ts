import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '@deterministic-agent-lab/journal';
import { runEchoAgent } from '../src/index';

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

describe('runEchoAgent', () => {
  it('returns a trimmed message and records the interaction', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'echo-agent-'));
    cleanup.push(workspace);

    const journal = new Journal({ filePath: join(workspace, 'intents.jsonl') });

    const result = await runEchoAgent({ message: '  hello  ' }, { journal });

    expect(result.echoed).toBe('hello');
    expect(result.journalSize).toBe(1);
  });
});
