import { describe, expect, it } from 'vitest';
import { parseTrace, serializeTrace } from '../src/index';

describe('trace bundle', () => {
  it('round-trips events through JSON', () => {
    const bundle = {
      id: 'bundle-1',
      events: [
        { timestamp: 1, channel: 'log', data: 'hello' },
        { timestamp: 2, channel: 'network', data: { status: 200 } }
      ]
    } as const;

    const payload = serializeTrace(bundle);
    const parsed = parseTrace(payload);

    expect(parsed).toEqual(bundle);
  });
});
