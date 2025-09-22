import { randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBundle } from '@deterministic-agent-lab/trace';

interface ProxyHandle {
  readonly port: number;
  readonly caPath: string;
  stop(): Promise<void>;
}

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReplayVerificationDiff {
  readonly kind: 'stdout' | 'stderr';
  readonly message: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ReplayVerificationResult {
  readonly success: boolean;
  readonly stdoutMatches: boolean;
  readonly stderrMatches: boolean;
  readonly stdoutDiff?: ReplayVerificationDiff;
  readonly stderrDiff?: ReplayVerificationDiff;
  readonly exitCode: number;
  readonly workspacePath?: string;
}

export interface ReplayVerifyOptions {
  readonly bundlePath: string;
  readonly dockerCommand?: string;
  readonly additionalEnv?: Record<string, string>;
  readonly keepWorkspace?: boolean;
  readonly quiet?: boolean;
}

export async function verifyBundle(options: ReplayVerifyOptions): Promise<ReplayVerificationResult> {
  const dockerCommand = options.dockerCommand ?? 'docker';
  const extracted = await extractBundle(options.bundlePath);
  const cleanupTasks: Array<{ label: string; fn: () => Promise<void> }> = [
    { label: 'extraction', fn: () => removeExtraction(extracted) }
  ];

  try {
    const bundle = await openBundle(extracted.root);
    const manifest = bundle.manifest;

    const envPath = path.join(extracted.root, manifest.files.env);
    const recordedEnv = JSON.parse(await readFile(envPath, 'utf8')) as {
      seed?: number;
      startTime?: string;
      image?: string;
      command?: string[];
    };

    if (
      typeof recordedEnv.seed !== 'number' ||
      typeof recordedEnv.startTime !== 'string' ||
      typeof recordedEnv.image !== 'string' ||
      !Array.isArray(recordedEnv.command)
    ) {
      throw new Error('Recorded bundle env.json is missing required replay metadata');
    }

    const recordedStdout = await readRequiredFile(extracted.root, manifest.files.logs, 'stdout.log');
    const recordedStderr = await readRequiredFile(extracted.root, manifest.files.logs, 'stderr.log');
    const recordedPolicyPath = await materialiseLog(extracted.root, manifest.files.logs, 'policy.yaml');
    const recordedHarPath = path.join(extracted.root, manifest.files.network);
    const recordedPromptsCa = await materialisePrompt(extracted.root, manifest.files.prompts, 'proxy-ca.pem');

    const workspace = await recreateWorkspace(extracted.root, manifest.files.fsDiff);
    cleanupTasks.push({ label: 'workspace', fn: () => cleanupWorkspace(workspace) });

    const proxyArtifacts = await createProxyArtifacts();
    cleanupTasks.push({ label: 'proxyArtifacts', fn: () => removeArtifacts(proxyArtifacts) });

    await fs.copyFile(recordedPromptsCa, proxyArtifacts.caPath);

    const proxy = await startProxy({
      mode: 'replay',
      allowFile: recordedPolicyPath,
      harPath: recordedHarPath,
      caPath: proxyArtifacts.caPath
    });
    cleanupTasks.unshift({ label: 'proxy', fn: () => proxy.stop() });

    const dockerResult = await runDocker({
      dockerCommand,
      image: recordedEnv.image,
      command: recordedEnv.command,
      workdir: workspace.workDir,
      seed: recordedEnv.seed,
      startTime: recordedEnv.startTime,
      proxyPort: proxy.port,
      caCertPath: proxy.caPath,
      additionalEnv: options.additionalEnv
    });

    const stdoutDiff = createDiff('stdout', recordedStdout, dockerResult.stdout);
    const stderrDiff = createDiff('stderr', recordedStderr, dockerResult.stderr);

    const success = dockerResult.exitCode === 0 && !stdoutDiff && !stderrDiff;

    return {
      success,
      stdoutMatches: !stdoutDiff,
      stderrMatches: !stderrDiff,
      stdoutDiff,
      stderrDiff,
      exitCode: dockerResult.exitCode,
      workspacePath: options.keepWorkspace ? workspace.workDir : undefined
    } satisfies ReplayVerificationResult;
  } finally {
    await runCleanup(cleanupTasks, options.keepWorkspace ?? false);
  }
}

async function extractBundle(bundlePath: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'replay-bundle-'));
  await execTar(['-xzf', path.resolve(bundlePath), '-C', root]);
  return { root };
}

async function removeExtraction(extracted: { root: string }) {
  await rm(extracted.root, { recursive: true, force: true });
}

async function runCleanup(tasks: Array<{ label: string; fn: () => Promise<void> }>, keepWorkspace: boolean) {
  for (const task of tasks) {
    try {
      if (keepWorkspace && task.label === 'workspace') {
        continue;
      }
      await task.fn();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function readRequiredFile(root: string, dir: string, fileName: string): Promise<string> {
  const filePath = path.join(root, dir, fileName);
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read recorded ${fileName}: ${(error as Error).message}`);
  }
}

async function materialiseLog(root: string, logsDir: string, fileName: string): Promise<string> {
  const filePath = path.join(root, logsDir, fileName);
  if (!(await exists(filePath))) {
    throw new Error(`Missing recorded log ${fileName}`);
  }
  return filePath;
}

async function materialisePrompt(root: string, promptsDir: string, fileName: string): Promise<string> {
  const filePath = path.join(root, promptsDir, fileName);
  if (!(await exists(filePath))) {
    throw new Error(`Missing recorded prompt ${fileName}`);
  }
  return filePath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createProxyArtifacts() {
  const baseDir = path.join(os.tmpdir(), `replay-proxy-${process.pid}-${randomUUID()}`);
  await fs.mkdir(baseDir, { recursive: true });
  const caPath = path.join(baseDir, 'ca.pem');
  return { baseDir, caPath };
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
  const cliPath = require.resolve('@deterministic-agent-lab/proxy/dist/cli.js');
  await fs.mkdir(path.dirname(options.caPath), { recursive: true });

  const child = spawn(process.execPath, [
    cliPath,
    `--mode=${options.mode}`,
    `--allow=${options.allowFile}`,
    `--har=${options.harPath}`,
    `--ca=${options.caPath}`
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const port = await new Promise<number>((resolve, reject) => {
    let resolved = false;
    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/listening on http:\/\/[^:]+:(\d+)/i);
      if (match && !resolved) {
        resolved = true;
        resolve(Number.parseInt(match[1] ?? '0', 10));
      }
      if (!process.env.REPLAY_SILENT_PROXY) {
        process.stdout.write(`[proxy] ${text}`);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(`[proxy] ${chunk}`));
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
  dockerCommand: string;
  image: string;
  command: string[];
  workdir: string;
  seed: number;
  startTime: string;
  proxyPort: number;
  caCertPath: string;
  additionalEnv?: Record<string, string>;
}): Promise<DockerResult> {
  const proxyUrl = `http://127.0.0.1:${options.proxyPort}`;
  const args = [
    'run',
    '--rm',
    '--network=host',
    '-e', `AGENT_SEED=${options.seed}`,
    '-e', `AGENT_START_TIME=${options.startTime}`,
    '-e', 'AGENT_REPLAY=1',
    '-e', `HTTP_PROXY=${proxyUrl}`,
    '-e', `HTTPS_PROXY=${proxyUrl}`,
    '-e', `ALL_PROXY=${proxyUrl}`,
    '-e', `NODE_EXTRA_CA_CERTS=/workspace/.agent/ca.pem`,
    '-e', `REQUESTS_CA_BUNDLE=/workspace/.agent/ca.pem`,
    '-e', `CURL_CA_BUNDLE=/workspace/.agent/ca.pem`,
    '-v', `${options.workdir}:/workspace`,
    '-w', '/workspace'
  ];

  const environmentEntries = Object.entries(options.additionalEnv ?? {});
  for (const [key, value] of environmentEntries) {
    args.push('-e', `${key}=${value}`);
  }

  const commandArgs = [...args, options.image, ...options.command];

  const agentDir = path.join(options.workdir, '.agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(options.caCertPath, path.join(agentDir, 'ca.pem'));

  return spawnAndCapture(options.dockerCommand, commandArgs, { env: process.env });
}

async function spawnAndCapture(command: string, args: string[], options?: SpawnOptions): Promise<DockerResult> {
  return new Promise<DockerResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...(options ?? {}) }) as ChildProcessWithoutNullStreams;
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
      resolve({
        exitCode: code ?? 0,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('')
      });
    });
  });
}

async function recreateWorkspace(bundleRoot: string, fsDiffPath: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'replay-workspace-'));
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

  return { root, lowerDir, workDir };
}

async function cleanupWorkspace(workspace: { root: string }) {
  await rm(workspace.root, { recursive: true, force: true });
}

async function copyLowerToWork(lowerDir: string, workDir: string) {
  const entries = await fs.readdir(lowerDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const source = path.join(lowerDir, entry.name);
    const target = path.join(workDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyLowerToWork(source, target);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
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

function createDiff(kind: 'stdout' | 'stderr', expected: string, actual: string): ReplayVerificationDiff | undefined {
  if (expected === actual) {
    return undefined;
  }

  const expectedLines = expected.split(/\r?\n/);
  const actualLines = actual.split(/\r?\n/);
  const max = Math.max(expectedLines.length, actualLines.length);

  for (let i = 0; i < max; i += 1) {
    const exp = expectedLines[i];
    const act = actualLines[i];
    if (exp !== act) {
      return {
        kind,
        message: `Mismatch at line ${i + 1}:\n  expected: ${exp ?? '<missing>'}\n  actual:   ${act ?? '<missing>'}`,
        expected,
        actual
      };
    }
  }

  return {
    kind,
    message: `${kind} output differs (length ${expected.length} vs ${actual.length})`,
    expected,
    actual
  };
}

async function execTar(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar ${args.join(' ')} exited with code ${code ?? 0}`));
      }
    });
  });
}

async function extractTar(tarFile: string, destDir: string) {
  await fs.mkdir(destDir, { recursive: true });
  await execTar(['-xf', tarFile, '-C', destDir]);
}
