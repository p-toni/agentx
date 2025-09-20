import { describe, expect, it } from 'vitest';
import { AllowPolicy } from '../src/policy';

describe('AllowPolicy', () => {
  it('permits configured methods and path prefixes', () => {
    const policy = new AllowPolicy([
      {
        host: 'api.example.com',
        methods: ['GET', 'POST'],
        pathPrefixes: ['/v1']
      }
    ]);

    expect(policy.isAllowed({ host: 'api.example.com', port: 443, method: 'GET', path: '/v1/users' })).toBe(true);
    expect(policy.isAllowed({ host: 'api.example.com', port: 443, method: 'DELETE', path: '/v1/users' })).toBe(false);
    expect(policy.isAllowed({ host: 'api.example.com', port: 443, method: 'GET', path: '/v2' })).toBe(false);
    expect(policy.isAllowed({ host: 'other.example.com', port: 443, method: 'GET', path: '/v1/users' })).toBe(false);
  });
});
