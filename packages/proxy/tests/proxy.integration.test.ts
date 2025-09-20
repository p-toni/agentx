import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { AllowPolicy, loadPolicy, savePolicyTemplate } from '../src/policy';
import { EgressProxy } from '../src/proxy-server';
import { configureProxyEnvironment } from '../src/client';

const tempDirs: string[] = [];
const shouldSkip = process.env.CI === 'true' || process.env.SKIP_PROXY_INTEGRATION === '1';
const suite = shouldSkip ? describe.skip : describe;

suite('EgressProxy integration', () => {
  let container: StartedTestContainer;
  let httpbinUrl: string;
  let runtimeAvailable = true;

  beforeAll(async () => {
    try {
      container = await new GenericContainer('kennethreitz/httpbin').withExposedPorts(80).start();
      httpbinUrl = `http://${container.getHost()}:${container.getMappedPort(80)}`;
    } catch (error) {
      runtimeAvailable = false;
      console.warn(`Skipping proxy integration tests: ${(error as Error).message}`);
    }
  });

  afterAll(async () => {
    if (container && runtimeAvailable) {
      await container.stop();
    }
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('records allowed requests and replays them byte-for-byte', async () => {
    if (!runtimeAvailable) {
      return;
    }

    if (!runtimeAvailable) {
      return;
    }

    const workspace = await createWorkspace();
    const harPath = join(workspace, 'session.har');
    const caPath = join(workspace, 'ca.pem');
    const policyPath = join(workspace, 'policy.yaml');

    await savePolicyTemplate(policyPath, {
      rules: [
        {
          host: `${container.getHost()}:${container.getMappedPort(80)}`,
          methods: ['GET'],
          pathPrefixes: ['/get']
        }
      ]
    });

    const policy = await loadPolicy(policyPath);

    const recordProxy = new EgressProxy({
      mode: 'record',
      policy,
      harPath,
      caCertPath: caPath,
      listenHost: '127.0.0.1'
    });

    const recordResult = await recordProxy.start();
    const recordHandle = configureProxyEnvironment({
      proxyUrl: `http://${recordResult.host}:${recordResult.port}`
    });

    const recordResponse = await fetch(`${httpbinUrl}/get?agent=record`, {
      headers: { 'x-egress-test': 'record' }
    });
    const recordBody = await recordResponse.text();
    expect(recordResponse.status).toBe(200);

    recordHandle.restore();
    await recordProxy.stop();

    const harRaw = await readFile(harPath, 'utf8');
    const harJson = JSON.parse(harRaw);
    expect(harJson.log.entries).toHaveLength(1);

    const replayProxy = new EgressProxy({
      mode: 'replay',
      policy,
      harPath,
      caCertPath: caPath,
      listenHost: '127.0.0.1'
    });

    const replayResult = await replayProxy.start();
    const replayHandle = configureProxyEnvironment({
      proxyUrl: `http://${replayResult.host}:${replayResult.port}`
    });

    const replayResponse = await fetch(`${httpbinUrl}/get?agent=record`, {
      headers: { 'x-egress-test': 'record' }
    });
    const replayBody = await replayResponse.text();
    expect(replayResponse.status).toBe(200);
    expect(replayBody).toBe(recordBody);

    replayHandle.restore();
    await replayProxy.stop();
  }, 120_000);

  it('denies requests not matching the allow policy', async () => {
    if (!runtimeAvailable) {
      return;
    }

    const workspace = await createWorkspace();
    const harPath = join(workspace, 'session.har');
    const caPath = join(workspace, 'ca.pem');
    const policy = new AllowPolicy([
      {
        host: `${container.getHost()}:${container.getMappedPort(80)}`,
        methods: ['GET'],
        pathPrefixes: ['/status']
      }
    ]);

    const proxy = new EgressProxy({
      mode: 'passthrough',
      policy,
      harPath,
      caCertPath: caPath,
      listenHost: '127.0.0.1'
    });

    const result = await proxy.start();
    const handle = configureProxyEnvironment({ proxyUrl: `http://${result.host}:${result.port}` });

    const blocked = await fetch(`${httpbinUrl}/get`, { headers: { 'x-egress-test': 'blocked' } });
    expect(blocked.status).toBe(403);

    handle.restore();
    await proxy.stop();
    expect(proxy.getBlockedRequests().length).toBeGreaterThan(0);
  }, 60_000);
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-tests-'));
  tempDirs.push(dir);
  return dir;
}
