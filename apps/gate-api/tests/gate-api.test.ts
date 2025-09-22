import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createBundle } from '@deterministic-agent-lab/trace';
import { buildServer, type DriverFactory } from '../src/server';
import type { Driver, Intent } from '@deterministic-agent-lab/journal';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoPolicyDir = join(__dirname, '..', '..', '..', 'policy');

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
});

describe('transaction gate API', () => {
  it('requires approval before commit and persists receipts for revert', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gate-api-'));
    cleanup.push(workspace);

    const policyDir = join(workspace, 'policy');
    await mkdir(policyDir, { recursive: true });
    await copyFile(join(repoPolicyDir, 'policy.wasm'), join(policyDir, 'policy.wasm'));
    await writeFile(
      join(policyDir, 'data.json'),
      JSON.stringify(
        {
          config: {
            version: 'v1',
            allow: [
              {
                domains: ['example.com'],
                methods: ['POST'],
                paths: ['/api']
              }
            ],
            caps: {
              maxAmount: 1000
            },
            requireApprovalLabels: ['external_email']
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const bundleDir = join(workspace, 'bundle');
    cleanup.push(bundleDir);
    const bundleTarget = join(workspace, 'bundle.tgz');
    await createBundle(bundleDir, {
      createdAt: '2024-01-01T00:00:00.000Z',
      intents: [
        {
          timestamp: '2024-01-01T00:00:00.000Z',
          intent: 'test.mock',
          payload: {
            id: 'intent-1',
            labels: ['external_email'],
            amount: 10,
            action: 'send'
          }
        }
      ],
      network: JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://example.com/api'
              }
            }
          ]
        }
      })
    });

    await createTarball(bundleDir, bundleTarget);

    const calls: string[] = [];
    const driverFactory: DriverFactory = () => createMockDriver(calls);

    const server = buildServer({
      dataDir: workspace,
      policyPath: policyDir,
      drivers: {
        'test.mock': driverFactory
      }
    });

    const upload = await server.inject({
      method: 'POST',
      url: '/bundles',
      payload: {
        bundle: await fileToBase64(bundleTarget)
      }
    });

    expect(upload.statusCode).toBe(201);
    const bundleId = (upload.json() as { bundleId: string }).bundleId;
    expect(bundleId).toBeTruthy();

    const listPending = await server.inject({ method: 'GET', url: '/bundles' });
    expect(listPending.statusCode).toBe(200);
    const pendingJson = listPending.json() as { bundles: Array<{ id: string; status: string }> };
    expect(pendingJson.bundles[0]?.status).toBe('pending');

    const planResponse = await server.inject({ method: 'GET', url: `/bundles/${bundleId}/plan` });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json() as any;
    expect(plan.policy.requiresApproval).toBe(true);
    expect(plan.policy.bundle.allowed).toBe(true);
    expect(plan.policy.intents[0]?.approvalReasons ?? []).toContain(
      'intent test.mock label external_email requires approval'
    );
    expect(plan.policy.network[0]?.allowed).toBe(true);
    expect(plan.intents).toHaveLength(1);
    expect(plan.fsDiff.changed).toBeInstanceOf(Array);
    expect(plan.status).toBe('pending');

    const commitWithoutApproval = await server.inject({ method: 'POST', url: `/bundles/${bundleId}/commit` });
    expect(commitWithoutApproval.statusCode).toBe(403);

    const approval = await server.inject({
      method: 'POST',
      url: `/bundles/${bundleId}/approve`,
      payload: { actor: 'alice' }
    });
    expect(approval.statusCode).toBe(200);

    const listApproved = await server.inject({ method: 'GET', url: '/bundles' });
    expect(listApproved.statusCode).toBe(200);
    const approvedJson = listApproved.json() as { bundles: Array<{ id: string; status: string }> };
    expect(approvedJson.bundles[0]?.status).toBe('approved');

    const commit = await server.inject({ method: 'POST', url: `/bundles/${bundleId}/commit` });
    expect(commit.statusCode).toBe(200);
    expect(calls).toEqual(['plan', 'validate', 'prepare', 'commit']);

    const revert = await server.inject({ method: 'POST', url: `/bundles/${bundleId}/revert` });
    expect(revert.statusCode).toBe(200);
    expect(calls).toContain('rollback:receipt-applied');

    const listCommitted = await server.inject({ method: 'GET', url: '/bundles' });
    expect(listCommitted.statusCode).toBe(200);
    const committedJson = listCommitted.json() as { bundles: Array<{ id: string; status: string }> };
    expect(committedJson.bundles[0]?.status).toBe('committed');

    await server.close();
  });
});

function createMockDriver(calls: string[]): Driver<unknown, unknown, unknown> {
  return {
    async plan(_intent: Intent<unknown, unknown>): Promise<void> {
      calls.push('plan');
    },
    async validate(_intent: Intent<unknown, unknown>): Promise<void> {
      calls.push('validate');
    },
    async prepare(_intent: Intent<unknown, unknown>): Promise<Record<string, string>> {
      calls.push('prepare');
      return { prepared: 'state' };
    },
    async commit(
      _intent: Intent<unknown, unknown>,
      _prepared: unknown,
      _context: unknown
    ): Promise<Record<string, string>> {
      calls.push('commit');
      return { receipt: 'applied' };
    },
    async rollback(
      _intent: Intent<unknown, unknown>,
      prepared: unknown,
      _context: unknown
    ): Promise<void> {
      calls.push(`rollback:${serialise(prepared)}`);
    }
  };
}

function serialise(value: unknown): string {
  if (value && typeof value === 'object') {
    if ('receipt' in (value as Record<string, unknown>)) {
      return 'receipt-applied';
    }
    if ('prepared' in (value as Record<string, unknown>)) {
      return 'prepared-state';
    }
  }
  return String(value);
}

async function fileToBase64(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(filePath);
  return data.toString('base64');
}

async function createTarball(sourceDir: string, targetFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', targetFile, '-C', sourceDir, '.']);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? 0}`));
      }
    });
  });
}
