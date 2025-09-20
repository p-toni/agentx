import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/index';

describe('runAgent', () => {
  it('produces deterministic outputs for a seed', () => {
    const first = runAgent(7);
    const second = runAgent(7);

    expect(first.outputs).toEqual(second.outputs);
    expect(first.seed).toBe(7);
  });
});
