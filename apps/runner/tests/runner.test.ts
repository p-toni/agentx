import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hashBundle, openBundle } from '@deterministic-agent-lab/trace';
import type { TraceBundle } from '@deterministic-agent-lab/trace';
import { runAgent } from '../src/index';

const tempDirs: string[] = [];

describe('runAgent', () => {
  it('produces deterministic outputs for a seed', () => {
    const first = runAgent(7);
    const second = runAgent(7);

    expect(first.outputs).toEqual(second.outputs);
    expect(first.seed).toBe(7);
  });
});

describe('agent-run CLI', () => {
  let cliPath: string;
  let dockerAvailable = true;

  beforeAll(async () => {
    cliPath = path.resolve(__dirname, '../dist/agent-run.js');
    const repoRoot = path.resolve(__dirname, '../../..');
    if (!(await fileExists(cliPath))) {
      await exec('pnpm', ['--filter', '@deterministic-agent-lab/runner', 'build'], repoRoot);
    }
    const runtimeDist = path.resolve(repoRoot, 'packages/runtime-node/dist/index.js');
    if (!(await fileExists(runtimeDist))) {
      await exec('pnpm', ['--filter', '@deterministic-agent-lab/runtime-node', 'build'], repoRoot);
    }
    dockerAvailable = await hasDocker();
  });

  afterAll(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('records and replays deterministically', async () => {
    if (!dockerAvailable) {
      return;
    }

    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-runner-test-'));
    tempDirs.push(workspace);

    const scriptPath = path.join(workspace, 'echo.js');
    await writeFile(
      scriptPath,
      `const fs = require('fs');\nconst input = process.argv.slice(2).join(' ');\nconst trimmed = input.trim();\nfs.writeFileSync('echo.txt', trimmed + '\\n');\nconsole.log(JSON.stringify({ echoed: trimmed }));\n`
    );

    const baseTar = path.join(workspace, 'base.tar');
    await exec('tar', ['-cf', baseTar, '-C', workspace, 'echo.js']);

    const policyPath = path.join(workspace, 'policy.yaml');
    await writeFile(
      policyPath,
      `rules:\n  - host: 127.0.0.1:80\n    methods: ['GET']\n`
    );

    const recordBundle = path.join(workspace, 'record.tgz');
    await exec('node', [cliPath, 'record', '--image', 'node:20-alpine', '--bundle', recordBundle, '--allow', policyPath, '--base', baseTar, '--seed', '42', 'node', 'echo.js', '  hello  '], workspace);

    const replayBundleA = path.join(workspace, 'replay-a.tgz');
    const replayBundleB = path.join(workspace, 'replay-b.tgz');
    await exec('node', [cliPath, 'replay', '--bundle', recordBundle, '--output', replayBundleA]);
    await exec('node', [cliPath, 'replay', '--bundle', recordBundle, '--output', replayBundleB]);

    const hashA = await hashBundle(await openBundleFromTar(replayBundleA));
    const hashB = await hashBundle(await openBundleFromTar(replayBundleB));

    expect(hashA).toBe(hashB);
  }, 120_000);

  it('replays timer-heavy agents with identical output', async () => {
    if (!dockerAvailable) {
      return;
    }

    const repoRoot = path.resolve(__dirname, '../../..');
    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-runner-timer-'));
    tempDirs.push(workspace);

    const scriptSource = path.join(repoRoot, 'examples/agents/timer/timers.js');
    const scriptPath = path.join(workspace, 'timers.js');
    await cp(scriptSource, scriptPath);

    const runtimeSource = path.join(repoRoot, 'packages/runtime-node');
    const runtimeDest = path.join(workspace, 'node_modules', '@deterministic-agent-lab', 'runtime-node');
    await mkdir(runtimeDest, { recursive: true });
    await cp(path.join(runtimeSource, 'package.json'), path.join(runtimeDest, 'package.json'));
    await cp(path.join(runtimeSource, 'dist'), path.join(runtimeDest, 'dist'), { recursive: true });

    const baseTar = path.join(workspace, 'base.tar');
    await exec('tar', ['-cf', baseTar, '-C', workspace, 'timers.js', 'node_modules']);

    const policyPath = path.join(workspace, 'policy.yaml');
    await writeFile(
      policyPath,
      `rules:\n  - host: 127.0.0.1:80\n    methods: ['GET']\n`
    );

    const recordBundle = path.join(workspace, 'timers-record.tgz');
    await exec(
      'node',
      [
        cliPath,
        'record',
        '--image',
        'node:20-alpine',
        '--bundle',
        recordBundle,
        '--allow',
        policyPath,
        '--base',
        baseTar,
        '--seed',
        '73',
        'node',
        '-r',
        '@deterministic-agent-lab/runtime-node/register',
        'timers.js'
      ],
      workspace
    );

    const replayBundleA = path.join(workspace, 'timers-replay-a.tgz');
    const replayBundleB = path.join(workspace, 'timers-replay-b.tgz');
    await exec('node', [cliPath, 'replay', '--bundle', recordBundle, '--output', replayBundleA]);
    await exec('node', [cliPath, 'replay', '--bundle', recordBundle, '--output', replayBundleB]);

    const hashA = await hashBundle(await openBundleFromTar(replayBundleA));
    const hashB = await hashBundle(await openBundleFromTar(replayBundleB));

    expect(hashA).toBe(hashB);
  }, 180_000);
});

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

async function openBundleFromTar(bundlePath: string): Promise<TraceBundle> {
  const extractDir = await mkdtemp(path.join(tmpdir(), 'agent-bundle-open-'));
  tempDirs.push(extractDir);
  const child = spawn('tar', ['-xzf', bundlePath, '-C', extractDir]);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? 0}`));
      }
    });
  });
  return openBundle(extractDir);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
