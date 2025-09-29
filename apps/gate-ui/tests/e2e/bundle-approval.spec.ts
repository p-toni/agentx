import { test, expect } from '@playwright/test';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import next from 'next';
import { AddressInfo } from 'node:net';
import { createBundle } from '@deterministic-agent-lab/trace';
import { buildServer } from '../../../gate-api/src/server';
import type { Driver, Intent } from '@deterministic-agent-lab/journal';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoPolicyDir = join(__dirname, '..', '..', '..', 'policy');

test.describe('bundle approval flow', () => {
  let workspace: string;
  let gateServer: FastifyInstance;
  let gateUrl: string;
  let nextServer: http.Server;
  let uiUrl: string;
  const driverCalls: string[] = [];

  test.beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'gate-e2e-'));
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
            requireApprovalLabels: ['external_email', 'calendar'],
            timeWindow: {
              start: '00:00',
              end: '23:59',
              timezone: 'UTC'
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    gateServer = buildServer({
      policyPath: policyDir,
      dataDir: join(workspace, 'data'),
      drivers: {
        'test.mock': () => createMockDriver(driverCalls)
      }
    });
    await gateServer.listen({ port: 0, host: '127.0.0.1' });
    const addressInfo = gateServer.server.address() as AddressInfo;
    gateUrl = `http://127.0.0.1:${addressInfo.port}`;

    process.env.NEXT_PUBLIC_GATE_API_URL = gateUrl;
    process.env.NODE_ENV = 'development';

    const app = next({ dev: true, dir: join(__dirname, '..', '..') });
    await app.prepare();
    const handler = app.getRequestHandler();
    nextServer = http.createServer((req, res) => {
      handler(req, res);
    });
    await new Promise<void>((resolve) => {
      nextServer.listen(0, '127.0.0.1', () => resolve());
    });
    const info = nextServer.address() as AddressInfo;
    uiUrl = `http://127.0.0.1:${info.port}`;

    const health = await fetch(`${gateUrl}/bundles`);
    await health.json();
  });

  test.afterAll(async () => {
    if (gateServer) {
      await gateServer.close();
    }
    if (nextServer) {
      await new Promise<void>((resolve) => nextServer.close(() => resolve()));
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('upload, approve, commit, revert', async ({ page }) => {
    driverCalls.length = 0;
    await page.goto(`${uiUrl}/login`);
    await page.fill('input[name="username"]', 'alice');
    await page.click('button:has-text("Sign In")');

    await page.waitForURL('**/bundles');

    const bundleDir = join(workspace, 'bundle');
    const bundleTar = join(workspace, 'bundle.tgz');
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
    await createTarball(bundleDir, bundleTar);

    await page.setInputFiles('input[type="file"]', bundleTar);
    await page.waitForSelector('table tbody tr');

    const bundlesTable = page.locator('table tbody tr').first();
    await bundlesTable.click();

    await page.waitForSelector('.button-row');
    await expect(page.locator('.badge')).toHaveText(/pending/i);

    await page.click('button:has-text("Approve")');
    await expect(page.locator('.toast', { hasText: 'Bundle approved' })).toBeVisible();

    await page.click('button:has-text("Commit")');
    await expect(page.locator('.toast', { hasText: 'Bundle committed' })).toBeVisible();
    await expect(page.locator('.badge')).toHaveText(/committed/i, { timeout: 5000 });

    await page.click('button:has-text("Revert")');
    await expect(page.locator('.toast', { hasText: 'Bundle reverted' })).toBeVisible();
    expect(driverCalls).toContain('commit');
    expect(driverCalls.some((call) => call.startsWith('rollback'))).toBeTruthy();
  });
});

function createMockDriver(calls: string[]): Driver<unknown, unknown, unknown> {
  return {
    async plan(): Promise<void> {
      calls.push('plan');
    },
    async validate(): Promise<void> {
      calls.push('validate');
    },
    async prepare(): Promise<Record<string, string>> {
      calls.push('prepare');
      return { receipt: 'prepared' };
    },
    async commit(): Promise<Record<string, string>> {
      calls.push('commit');
      return { receipt: 'success' };
    },
    async rollback(_intent: Intent<unknown, unknown>, prepared: unknown): Promise<void> {
      calls.push(`rollback:${JSON.stringify(prepared)}`);
    }
  };
}
