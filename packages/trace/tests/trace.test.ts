import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createBundle,
  createTemporaryBundleDirectory,
  hashBundle,
  openBundle,
  TraceBundleValidationError,
  TRACE_BUNDLE_VERSION,
  validateBundle
} from '../src';

const FIXED_TIMESTAMP = '2024-01-01T00:00:00.000Z';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe('trace bundle helpers', () => {
  it('creates, validates, and reopens a minimal bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trace-bundle-test-'));
    tempDirs.push(dir);

    const bundle = await createBundle(dir, {
      createdAt: FIXED_TIMESTAMP,
      description: 'sample bundle',
      metadata: { runId: 'run-123' },
      env: { seed: 'seed-1', variables: { FOO: 'bar' } },
      clock: { initialTime: FIXED_TIMESTAMP, ticks: [] },
      logs: { 'agent.log': 'hello world\n' },
      prompts: {
        '0001.json': JSON.stringify(
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Hello agent'
          },
          null,
          2
        )
      },
      intents: [
        {
          timestamp: FIXED_TIMESTAMP,
          intent: 'agent.say',
          payload: { message: 'hello' }
        }
      ]
    });

    expect(bundle.manifest.version).toBe(TRACE_BUNDLE_VERSION);
    await validateBundle(bundle);

    const reopened = await openBundle(dir);
    expect(reopened.manifest).toEqual(bundle.manifest);

    const hash = await hashBundle(reopened);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces stable hashes for identical inputs', async () => {
    const firstDir = await createTemporaryBundleDirectory('trace-bundle-test-');
    const secondDir = await createTemporaryBundleDirectory('trace-bundle-test-');
    tempDirs.push(firstDir, secondDir);

    const input = {
      createdAt: FIXED_TIMESTAMP,
      env: { seed: 'seed-stable', variables: {} },
      intents: [
        {
          timestamp: FIXED_TIMESTAMP,
          intent: 'noop'
        }
      ]
    } as const;

    const firstBundle = await createBundle(firstDir, input);
    const secondBundle = await createBundle(secondDir, input);

    const firstHash = await hashBundle(firstBundle);
    const secondHash = await hashBundle(secondBundle);

    expect(firstHash).toBe(secondHash);
  });

  it('rejects manifests that fail schema validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trace-bundle-test-'));
    tempDirs.push(dir);

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          version: TRACE_BUNDLE_VERSION,
          createdAt: FIXED_TIMESTAMP,
          files: {
            env: 'env.json',
            clock: 'clock.json',
            network: 'network.har',
            fsDiff: 'fs-diff',
            prompts: 'prompts',
            intents: 'intents.jsonl'
          }
        },
        null,
        2
      )
    );

    await mkdir(join(dir, 'fs-diff'), { recursive: true });
    await mkdir(join(dir, 'prompts'), { recursive: true });
    await writeFile(join(dir, 'env.json'), '{}');
    await writeFile(join(dir, 'clock.json'), '{}');
    await writeFile(join(dir, 'network.har'), '{}');
    await writeFile(join(dir, 'intents.jsonl'), '');

    await expect(openBundle(dir)).rejects.toBeInstanceOf(TraceBundleValidationError);
  });
});
