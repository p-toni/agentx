import { describe, expect, it } from 'vitest';
import { runEchoAgent } from '../src/index';

describe('runEchoAgent', () => {
  it('returns a trimmed message and records the interaction', () => {
    const result = runEchoAgent({ message: '  hello  ' });

    expect(result.echoed).toBe('hello');
    expect(result.journalSize).toBe(1);
  });
});
