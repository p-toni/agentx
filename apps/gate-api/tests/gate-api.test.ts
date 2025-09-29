import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createBundle } from '@deterministic-agent-lab/trace';
import { buildServer, type DriverFactory, type PlanResponse } from '../src/server';
import type { Driver, Intent, HttpPostReceipt } from '@deterministic-agent-lab/journal';
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
  }, 30000);

  it('surfaces rollback registry rules for http.post intents and reverts successfully', async () => {
    let deleteCount = 0;
    const httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/messages') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messageId: 'message-1' }));
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/messages/message-1') {
        deleteCount += 1;
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const httpAddress = httpServer.address() as AddressInfo;
    const messageUrl = `http://127.0.0.1:${httpAddress.port}/messages`;

    const workspace = await mkdtemp(join(tmpdir(), 'gate-api-http-rollback-'));
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
                domains: ['127.0.0.1'],
                methods: ['POST', 'DELETE'],
                paths: ['/messages']
              }
            ]
          }
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(
      join(policyDir, 'http-rollback.yaml'),
      `rules:\n  - name: message-create\n    host: 127.0.0.1\n    commit:\n      method: POST\n      path: /messages\n      idFrom:\n        - json:$.messageId\n    rollback:\n      method: DELETE\n      pathTemplate: /messages/{id}\n`
    );

    const bundleDir = join(workspace, 'bundle');
    await mkdir(bundleDir, { recursive: true });
    await createBundle(bundleDir, {
      createdAt: '2024-03-01T00:00:00.000Z',
      intents: [
        {
          timestamp: '2024-03-01T00:00:01.000Z',
          intent: 'http.post',
          payload: {
            url: messageUrl,
            body: { message: 'observe rollback registry' }
          }
        }
      ],
      network: JSON.stringify({ log: { entries: [] } })
    });

    const bundlePath = join(workspace, 'bundle.tgz');
    await createTarball(bundleDir, bundlePath);

    const dataDir = join(workspace, '.gate');
    const server = buildServer({ policyPath: policyDir, dataDir });

    const upload = await server.inject({
      method: 'POST',
      url: '/bundles',
      payload: { bundle: await fileToBase64(bundlePath) }
    });
    expect(upload.statusCode).toBe(201);
    const bundleId = (upload.json() as { bundleId: string }).bundleId;

    const plan = await server.inject({ method: 'GET', url: `/bundles/${bundleId}/plan` });
    expect(plan.statusCode).toBe(200);
    const planJson = plan.json() as PlanResponse;
    expect(planJson.intents[0]?.rollback).toEqual(
      expect.objectContaining({
        available: true,
        rule: 'message-create',
        method: 'DELETE',
        pathTemplate: '/messages/{id}'
      })
    );

    const commit = await server.inject({ method: 'POST', url: `/bundles/${bundleId}/commit` });
    expect(commit.statusCode).toBe(200);
    const commitJson = commit.json() as {
      receipts: Array<{ receipt: HttpPostReceipt }>;
    };
    expect(commitJson.receipts[0]?.receipt.metadata?.rollbackRule?.id).toBe('message-1');

    const revert = await server.inject({ method: 'POST', url: `/bundles/${bundleId}/revert` });
    expect(revert.statusCode).toBe(200);
    expect(deleteCount).toBeGreaterThanOrEqual(1);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 30000);
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
