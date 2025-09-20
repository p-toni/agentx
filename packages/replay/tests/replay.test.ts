import { describe, expect, it } from 'vitest';
import { DeterministicReplay, createSeededRng } from '../src/index';

describe('DeterministicReplay', () => {
  it('plays events in timestamp order', () => {
    const replay = new DeterministicReplay({
      id: 'bundle',
      events: [
        { timestamp: 3, channel: 'log', data: 'late' },
        { timestamp: 1, channel: 'log', data: 'first' },
        { timestamp: 2, channel: 'log', data: 'second' }
      ]
    });

    const seen: unknown[] = [];
    replay.play((event) => seen.push(event.data));

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
