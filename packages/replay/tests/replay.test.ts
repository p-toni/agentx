import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  createBundle,
  createTemporaryBundleDirectory,
  openBundle
} from '@deterministic-agent-lab/trace';
import { DeterministicReplay, createSeededRng } from '../src/index';

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

describe('DeterministicReplay', () => {
  it('plays intents in timestamp order', async () => {
    const dir = await createTemporaryBundleDirectory('replay-bundle-');
    cleanup.push(dir);

    await createBundle(dir, {
      createdAt: '2024-01-01T00:00:00.000Z',
      intents: [
        {
          timestamp: '2024-01-01T00:00:03.000Z',
          intent: 'late'
        },
        {
          timestamp: '2024-01-01T00:00:01.000Z',
          intent: 'first'
        },
        {
          timestamp: '2024-01-01T00:00:02.000Z',
          intent: 'second'
        }
      ]
    });

    const bundle = await openBundle(dir);
    const replay = await DeterministicReplay.fromBundle(bundle);

    const seen: string[] = [];
    replay.play((intent) => seen.push(intent.intent));

    expect(seen).toEqual(['first', 'second', 'late']);
  });
});

describe('createSeededRng', () => {
  it('produces deterministic sequences', () => {
    const rngA = createSeededRng(42);
    const rngB = createSeededRng(42);

    expect([rngA(), rngA(), rngA()]).toEqual([rngB(), rngB(), rngB()]);
  });
});
