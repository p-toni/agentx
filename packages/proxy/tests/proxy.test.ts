import { describe, expect, it } from 'vitest';
import { AllowlistProxy } from '../src/index';

describe('AllowlistProxy', () => {
  it('allows only configured methods for a host', () => {
    const proxy = new AllowlistProxy([
      { host: 'api.example.com', methods: ['GET', 'POST'] }
    ]);

    expect(proxy.isAllowed(new URL('https://api.example.com/v1'), 'GET')).toBe(true);
    expect(proxy.isAllowed(new URL('https://api.example.com/v1'), 'DELETE')).toBe(false);
    expect(proxy.isAllowed(new URL('https://other.example.com/v1'), 'GET')).toBe(false);
  });
});
