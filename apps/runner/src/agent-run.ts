import { Command } from 'commander';
import { spawn, SpawnOptions, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBundle, createBundle, hashBundle } from '@deterministic-agent-lab/trace';

interface RecordOptions {
  image: string;
  bundle: string;
  allow: string;
  base?: string;
  seed?: number;
}

interface ReplayOptions {
  bundle: string;
  output: string;
}

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ProxyHandle {
  port: number;
  caPath: string;
  stop(): Promise<void>;
}

const program = new Command();

program
  .name('agent-run')
  .description('Deterministic agent runner with recording and replay capabilities');

program
  .command('record')
  .description('Record an agent execution into a trace bundle')
  .requiredOption('--image <image>', 'Docker image to run')
  .requiredOption('--bundle <file>', 'Output bundle (.tgz) path')
  .requiredOption('--allow <file>', 'Proxy allowlist policy YAML')
  .option('--base <tar>', 'Optional base tarball for workspace lower layer')
  .option('--seed <number>', 'Seed value for deterministic RNG', (value) => Number.parseInt(value, 10))
  .argument('<cmd...>', 'Command to execute inside the container')
  .action(async (cmd: string[], options: RecordOptions) => {
    const seed = Number.isFinite(options.seed) ? Number(options.seed) : randomInt(0, Number.MAX_SAFE_INTEGER);
    const startTime = new Date().toISOString();

    const workspace = await createWorkspace(options.base);
    const proxyArtifacts = await createProxyArtifacts();
    const proxyHandle = await startProxy({
      mode: 'record',
      allowFile: path.resolve(options.allow),
      harPath: proxyArtifacts.harPath,
      caPath: proxyArtifacts.caPath
    });

    let dockerResult: DockerResult | undefined;

    try {
      dockerResult = await runDocker({
        image: options.image,
        command: cmd,
        workdir: workspace.workDir,
        seed,
        startTime,
        proxyPort: proxyHandle.port,
        caCertPath: proxyArtifacts.caPath
      });
    } finally {
      await proxyHandle.stop();
    }

    if (!dockerResult) {
      throw new Error('Docker run did not produce a result');
    }

    const fsDiff = await createFilesystemDiff(workspace.lowerDir, workspace.workDir);
    const diffEntries: Record<string, Buffer | string> = {
      'base.tar': await fs.readFile(workspace.baseTarPath),
      'diff/deleted.json': JSON.stringify(fsDiff.deleted, null, 2)
    };

    for (const entry of fsDiff.files) {
      const data = await fs.readFile(entry.absolutePath);
      diffEntries[`diff/files/${entry.relativePath}`] = data;
    }

    const bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-bundle-'));
    const networkHar = await readFile(proxyArtifacts.harPath, 'utf8');
    const caContents = await readFile(proxyArtifacts.caPath);
    await createBundle(bundleRoot, {
      createdAt: new Date().toISOString(),
      metadata: {
        mode: 'record',
        image: options.image,
        command: cmd,
        seed,
        startTime
      },
      env: {
        seed,
        startTime,
        image: options.image,
        command: cmd
      },
      clock: {
        initialTime: startTime,
        ticks: []
      },
      network: networkHar,
      logs: {
        'stdout.log': dockerResult.stdout,
        'stderr.log': dockerResult.stderr,
        'policy.yaml': await readFile(path.resolve(options.allow), 'utf8')
      },
      prompts: {
        'proxy-ca.pem': caContents
      },
      fsDiff: diffEntries,
      intents: []
    });

    const outputPath = path.resolve(options.bundle);
    await tarDirectory(bundleRoot, outputPath);
    await cleanupWorkspace(workspace);
    await removeArtifacts(proxyArtifacts);

    console.log(`Trace bundle written to ${outputPath}`);
  });

program
  .command('replay')
  .description('Replay an agent run from a trace bundle')
  .requiredOption('--bundle <file>', 'Input bundle (.tgz) path')
  .requiredOption('--output <file>', 'Output bundle (.tgz) path for the replay run')
  .action(async (options: ReplayOptions) => {
    const extracted = await extractBundle(path.resolve(options.bundle));
    const bundle = await openBundle(extracted.root);
    const manifest = bundle.manifest;

    const envPath = path.join(extracted.root, manifest.files.env);
    const envData = JSON.parse(await readFile(envPath, 'utf8')) as {
      seed: number;
      startTime: string;
      image: string;
      command: string[];
    };
    const proxyArtifacts = await createProxyArtifacts();
    const harPath = path.join(extracted.root, manifest.files.network);
    const policyPath = await materialiseLog(extracted.root, manifest.files.logs, 'policy.yaml');
    const caPath = await materialisePrompt(extracted.root, manifest.files.prompts, 'proxy-ca.pem');

    const proxyHandle = await startProxy({
      mode: 'replay',
      allowFile: policyPath,
      harPath,
      caPath: proxyArtifacts.caPath
    });

    let dockerResult: DockerResult | undefined;
    const workspace = await recreateWorkspace(extracted.root, manifest.files.fsDiff);

    try {
      dockerResult = await runDocker({
        image: envData.image,
        command: envData.command,
        workdir: workspace.workDir,
        seed: envData.seed,
        startTime: envData.startTime,
        proxyPort: proxyHandle.port,
        caCertPath: proxyArtifacts.caPath
      });
    } finally {
      await proxyHandle.stop();
    }

    if (!dockerResult) {
      throw new Error('Docker run did not produce a result');
    }

    const fsDiff = await createFilesystemDiff(workspace.lowerDir, workspace.workDir);
    const diffEntries: Record<string, Buffer | string> = {
      'base.tar': await fs.readFile(workspace.baseTarPath),
      'diff/deleted.json': JSON.stringify(fsDiff.deleted, null, 2)
    };

    for (const entry of fsDiff.files) {
      diffEntries[`diff/files/${entry.relativePath}`] = await fs.readFile(entry.absolutePath);
    }

    const bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-replay-bundle-'));
    await createBundle(bundleRoot, {
      createdAt: new Date().toISOString(),
      metadata: {
        mode: 'replay',
        replayOf: path.resolve(options.bundle),
        image: envData.image,
        command: envData.command,
        seed: envData.seed,
        startTime: envData.startTime
      },
      env: envData,
      clock: JSON.parse(await readFile(path.join(extracted.root, manifest.files.clock), 'utf8')),
      network: await readFile(harPath, 'utf8'),
      logs: {
        'stdout.log': dockerResult.stdout,
        'stderr.log': dockerResult.stderr,
        'policy.yaml': await readFile(policyPath, 'utf8')
      },
      prompts: {
        'proxy-ca.pem': await readFile(caPath)
      },
      fsDiff: diffEntries,
      intents: []
    });

    const outputPath = path.resolve(options.output);
    await tarDirectory(bundleRoot, outputPath);
    let originalHash = '';
    let replayHash = '';

    try {
      originalHash = await hashBundle(bundle);
      const replayBundle = await openBundle(bundleRoot);
      replayHash = await hashBundle(replayBundle);
    } finally {
      await cleanupWorkspace(workspace);
      await removeArtifacts(proxyArtifacts);
      await removeExtraction(extracted);
    }

    console.log(`Original hash: ${originalHash}`);
    console.log(`Replay hash:   ${replayHash}`);

    console.log(`Replay bundle written to ${outputPath}`);
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function createProxyArtifacts() {
  const baseDir = path.join(os.tmpdir(), `agent-proxy-${process.pid}-${Date.now()}`);
  await fs.mkdir(baseDir, { recursive: true });
  const harPath = path.join(baseDir, 'network.har');
  const caPath = path.join(baseDir, 'ca.pem');
  return { baseDir, harPath, caPath };
}

async function removeArtifacts(artifacts: { baseDir: string }) {
  await rm(artifacts.baseDir, { recursive: true, force: true });
}

async function startProxy(options: {
  mode: 'record' | 'replay';
  allowFile: string;
  harPath: string;
  caPath: string;
}): Promise<ProxyHandle> {
  await fs.mkdir(path.dirname(options.harPath), { recursive: true });
  const cliPath = require.resolve('@deterministic-agent-lab/proxy/dist/cli.js');
  await fs.mkdir(path.dirname(options.caPath), { recursive: true });
  const args = [
    cliPath,
    `--mode=${options.mode}`,
    `--allow=${options.allowFile}`,
    `--har=${options.harPath}`,
    `--ca=${options.caPath}`
  ];

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const port = await new Promise<number>((resolve, reject) => {
    let resolved = false;
    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/listening on http:\/\/([^:]+):(\d+)/i);
      if (match) {
        resolved = true;
        resolve(Number(match[2]));
      }
      process.stdout.write(`[proxy] ${text}`);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (data) => process.stderr.write(`[proxy] ${data}`));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Proxy exited with code ${code ?? 0}`));
      }
    });
  });

  return {
    port,
    caPath: options.caPath,
    async stop() {
      if (!child.killed) {
        child.kill('SIGINT');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  };
}

async function runDocker(options: {
  image: string;
  command: string[];
  workdir: string;
  seed: number;
  startTime: string;
  proxyPort: number;
  caCertPath: string;
}): Promise<DockerResult> {
  const proxyUrl = `http://127.0.0.1:${options.proxyPort}`;
  const args = [
    'run',
    '--rm',
    '--network=host',
    '-e', `AGENT_SEED=${options.seed}`,
    '-e', `AGENT_START_TIME=${options.startTime}`,
    '-e', `HTTP_PROXY=${proxyUrl}`,
    '-e', `HTTPS_PROXY=${proxyUrl}`,
    '-e', `ALL_PROXY=${proxyUrl}`,
    '-e', `NODE_EXTRA_CA_CERTS=/workspace/.agent/ca.pem`,
    '-e', `REQUESTS_CA_BUNDLE=/workspace/.agent/ca.pem`,
    '-e', `CURL_CA_BUNDLE=/workspace/.agent/ca.pem`,
    '-v', `${options.workdir}:/workspace`,
    '-w', '/workspace'
  ];

  const commandArgs = [...args, options.image, ...options.command];

  const agentDir = path.join(options.workdir, '.agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(options.caCertPath, path.join(agentDir, 'ca.pem'));

  return await spawnAndCapture('docker', commandArgs, { env: process.env });
}

async function spawnAndCapture(command: string, args: string[], options?: SpawnOptions): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = { stdio: 'pipe', ...(options ?? {}) };
    const child = spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      process.stderr.write(text);
    });

    child.once('error', reject);
    child.once('close', (code) => {
      const result: DockerResult = {
        exitCode: code ?? 0,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
      };
      if (result.exitCode !== 0) {
        reject(new Error(`${command} exited with code ${result.exitCode}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function createWorkspace(baseTar?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-'));
  const lowerDir = path.join(root, 'lower');
  const workDir = path.join(root, 'work');
  await fs.mkdir(lowerDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  if (baseTar) {
    await extractTar(path.resolve(baseTar), lowerDir);
  }

  await copyLowerToWork(lowerDir, workDir);
  const baseTarPath = path.join(root, 'base.tar');
  await createTar(lowerDir, baseTarPath);

  return { root, lowerDir, workDir, baseTarPath };
}

async function recreateWorkspace(bundleRoot: string, fsDiffPath: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-replay-workspace-'));
  const lowerDir = path.join(root, 'lower');
  const workDir = path.join(root, 'work');
  await fs.mkdir(lowerDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const fsDiffRoot = path.join(bundleRoot, fsDiffPath);
  const baseTar = path.join(fsDiffRoot, 'base.tar');
  await extractTar(baseTar, lowerDir);
  await copyLowerToWork(lowerDir, workDir);

  const diffFilesDir = path.join(fsDiffRoot, 'diff', 'files');
  const deletedFile = path.join(fsDiffRoot, 'diff', 'deleted.json');

  if (await exists(diffFilesDir)) {
    await applyDiffFiles(diffFilesDir, workDir);
  }

  if (await exists(deletedFile)) {
    const raw = await readFile(deletedFile, 'utf8');
    const deleted = JSON.parse(raw) as string[];
    for (const rel of deleted) {
      const target = path.join(workDir, rel);
      await rm(target, { recursive: true, force: true });
    }
  }

  const baseTarPath = path.join(root, 'base.tar');
  await createTar(lowerDir, baseTarPath);
  return { root, lowerDir, workDir, baseTarPath };
}

async function cleanupWorkspace(workspace: { root: string }) {
  await rm(workspace.root, { recursive: true, force: true });
}

async function removeExtraction(extracted: { root: string }) {
  await rm(extracted.root, { recursive: true, force: true });
}

async function copyLowerToWork(lowerDir: string, workDir: string) {
  if (await exists(lowerDir)) {
    const entries = await fs.readdir(lowerDir);
    if (entries.length > 0) {
      await cp(lowerDir, workDir, { recursive: true, force: true });
    }
  }
}

async function createTar(sourceDir: string, targetTar: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-cf', targetTar, '-C', sourceDir, '.']);
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

async function extractTar(tarFile: string, destDir: string) {
  await fs.mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', tarFile, '-C', destDir]);
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

async function tarDirectory(sourceDir: string, targetFile: string) {
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createFilesystemDiff(lowerDir: string, workDir: string) {
  const files: { relativePath: string; absolutePath: string }[] = [];
  const deleted: string[] = [];

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.agent') {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(workDir, absolute);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const lowerPath = path.join(lowerDir, relative);
        if (await exists(lowerPath)) {
          const [a, b] = await Promise.all([readFile(absolute), readFile(lowerPath)]);
          if (!a.equals(b as unknown as Uint8Array)) {
            files.push({ relativePath: relative, absolutePath: absolute });
          }
        } else {
          files.push({ relativePath: relative, absolutePath: absolute });
        }
      }
    }
  };

  await walk(workDir);

  const findDeleted = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(lowerDir, absolute);
      const target = path.join(workDir, relative);
      if (entry.isDirectory()) {
        await findDeleted(absolute);
      } else if (!(await exists(target))) {
        deleted.push(relative);
      }
    }
  };

  await findDeleted(lowerDir);

  return { files, deleted };
}

async function extractBundle(bundlePath: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-bundle-extract-'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', bundlePath, '-C', root]);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? 0}`));
      }
    });
  });
  return { root };
}

async function materialiseLog(bundleRoot: string, logsDir: string, fileName: string): Promise<string> {
  const logPath = path.join(bundleRoot, logsDir, fileName);
  if (!(await exists(logPath))) {
    throw new Error(`Missing log file ${fileName}`);
  }
  return logPath;
}

async function materialisePrompt(bundleRoot: string, promptDir: string, fileName: string): Promise<string> {
  const promptPath = path.join(bundleRoot, promptDir, fileName);
  if (!(await exists(promptPath))) {
    throw new Error(`Missing prompt file ${fileName}`);
  }
  return promptPath;
}

async function applyDiffFiles(diffDir: string, workDir: string) {
  const entries = await fs.readdir(diffDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(diffDir, entry.name);
    const target = path.join(workDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await applyDiffFiles(source, target);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
}
