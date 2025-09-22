import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { verifyBundle } from '../src';
import { hashBundle, openBundle } from '@deterministic-agent-lab/trace';

const tempDirs: string[] = [];
let dockerAvailable = true;
let runnerCliPath: string;
let replayCliPath: string;

beforeAll(async () => {
  dockerAvailable = await hasDocker();
  runnerCliPath = path.resolve(__dirname, '../../runner/dist/agent-run.js');
  replayCliPath = path.resolve(__dirname, '../dist/cli.js');

  if (dockerAvailable) {
    if (!(await fileExists(runnerCliPath))) {
      await exec('pnpm', ['--filter', '@deterministic-agent-lab/runner', 'build'], path.resolve(__dirname, '../../runner'));
    }
    if (!(await fileExists(replayCliPath))) {
      await exec('pnpm', ['--filter', '@deterministic-agent-lab/replay', 'build'], path.resolve(__dirname, '..'));
    }
  }
});

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const DOCKER_TIMEOUT = 180_000;

describe('replay verify', () => {
  it('detects tampered stdout', async () => {
    if (!dockerAvailable) {
      return;
    }

    const context = await prepareRecordingWorkspace();
    tempDirs.push(context.root);

    const bundlePath = path.join(context.root, 'record.tgz');
    await recordBundle(context, 101, bundlePath);

    const cleanResult = await verifyBundle({ bundlePath });
    expect(cleanResult.success).toBe(true);

    await mutateBundle(bundlePath, async (extracted) => {
      const stdoutPath = path.join(extracted, 'logs', 'stdout.log');
      await writeFile(stdoutPath, 'tampered', 'utf8');
    });

    const tampered = await verifyBundle({ bundlePath });
    expect(tampered.success).toBe(false);
    expect(tampered.stdoutDiff?.message).toMatch(/Mismatch/);
  }, DOCKER_TIMEOUT);

  it('command line interface returns non-zero on diff', async () => {
    if (!dockerAvailable) {
      return;
    }

    const context = await prepareRecordingWorkspace();
    tempDirs.push(context.root);
    const bundlePath = path.join(context.root, 'record.tgz');
    await recordBundle(context, 202, bundlePath);

    await mutateBundle(bundlePath, async (extracted) => {
      const stderrPath = path.join(extracted, 'logs', 'stderr.log');
      await writeFile(stderrPath, 'oops', 'utf8');
    });

    await expect(exec('node', [replayCliPath, 'verify', bundlePath])).rejects.toThrow();
  }, DOCKER_TIMEOUT);

  it('random seeds create distinct bundles that replay identically', async () => {
    if (!dockerAvailable) {
      return;
    }

    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 3 }), async (seeds) => {
        const context = await prepareRecordingWorkspace();
        tempDirs.push(context.root);

        const bundleHashes: string[] = [];
        for (const seed of seeds) {
          const bundlePath = path.join(context.root, `record-${seed}.tgz`);
          await recordBundle(context, seed, bundlePath);
          const verification = await verifyBundle({ bundlePath });
          expect(verification.success).toBe(true);
          const bundle = await openBundleFromTar(bundlePath);
          bundleHashes.push(await hashBundle(bundle));
        }

        const uniqueHashes = new Set(bundleHashes);
        expect(uniqueHashes.size).toBe(bundleHashes.length);
      }),
      { numRuns: 3, timeout: DOCKER_TIMEOUT }
    );
  }, DOCKER_TIMEOUT);
});

interface RecordingContext {
  root: string;
  scriptPath: string;
  baseTar: string;
  policyPath: string;
}

async function prepareRecordingWorkspace(): Promise<RecordingContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'replay-verify-'));
  const scriptPath = path.join(root, 'echo.js');
  await writeFile(
    scriptPath,
    `const fs = require('fs');\nconst input = process.argv.slice(2).join(' ');\nconst trimmed = input.trim();\nfs.writeFileSync('echo.txt', trimmed + '\\n');\nconsole.log(JSON.stringify({ echoed: trimmed }));\n`
  );

  const baseTar = path.join(root, 'base.tar');
  await exec('tar', ['-cf', baseTar, '-C', root, 'echo.js']);

  const policyPath = path.join(root, 'policy.yaml');
  await writeFile(
    policyPath,
    `rules:\n  - host: 127.0.0.1:80\n    methods: ['GET']\n`
  );

  return { root, scriptPath, baseTar, policyPath };
}

async function recordBundle(context: RecordingContext, seed: number, output: string): Promise<void> {
  await exec('node', [
    runnerCliPath,
    'record',
    '--image',
    'node:20-alpine',
    '--bundle',
    output,
    '--allow',
    context.policyPath,
    '--base',
    context.baseTar,
    '--seed',
    String(seed),
    'node',
    path.basename(context.scriptPath),
    '  hello  '
  ], context.root);
}

async function mutateBundle(bundlePath: string, mutate: (extracted: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), 'replay-mutate-'));
  try {
    await exec('tar', ['-xzf', bundlePath, '-C', temp]);
    await mutate(temp);
    await exec('tar', ['-czf', bundlePath, '-C', temp, '.']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function openBundleFromTar(bundlePath: string) {
  const extractDir = await mkdtemp(path.join(tmpdir(), 'replay-open-'));
  tempDirs.push(extractDir);
  await exec('tar', ['-xzf', bundlePath, '-C', extractDir]);
  return openBundle(extractDir);
}

async function hasDocker(): Promise<boolean> {
  try {
    await exec('docker', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function exec(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 0}`));
      }
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
