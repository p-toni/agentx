import { Command, Option } from 'commander';
import { spawn, SpawnOptions, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openBundle, createBundle, hashBundle } from '@deterministic-agent-lab/trace';

type ClockSnapshot = Record<string, unknown>;

interface RecordOptions {
  image: string;
  bundle: string;
  allow: string;
  base?: string;
  seed?: number;
  deterministic?: boolean;
}

interface ReplayOptions {
  bundle: string;
  output: string;
  deterministic?: boolean;
}

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DockerRunResult extends DockerResult {
  clock?: ClockSnapshot;
}

interface RunDockerOptions {
  image: string;
  command: string[];
  workspacePath: string;
  seed: number;
  startTime: string;
  proxyPort: number;
  caCertPath: string;
  mode: 'record' | 'replay';
  deterministic: boolean;
  clockData?: ClockSnapshot;
}

type WorkspaceMode = 'overlay' | 'copy';

interface WorkspaceInfo {
  root: string;
  lowerDir: string;
  mountDir: string;
  baseTarPath: string;
  mode: WorkspaceMode;
  upperDir?: string;
  overlayWorkDir?: string;
  unmountCommand?: {
    command: string;
    args: string[];
  };
  overlayType?: 'kernel' | 'fuse';
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

function parseDeterministicFlag(value?: string): boolean {
  if (!value) {
    return true;
  }

  const normalised = value.trim().toLowerCase();
  if (normalised === '' || normalised === 'true' || normalised === '1' || normalised === 'yes' || normalised === 'on') {
    return true;
  }

  if (normalised === 'false' || normalised === '0' || normalised === 'no' || normalised === 'off') {
    return false;
  }

  throw new Error(`Invalid value for --deterministic: ${value}`);
}

function createDeterministicOption(): Option {
  return new Option('--deterministic [mode]', 'Enable deterministic scheduling for the container (default: on)')
    .argParser(parseDeterministicFlag);
}

program
  .command('record')
  .description('Record an agent execution into a trace bundle')
  .requiredOption('--image <image>', 'Docker image to run')
  .requiredOption('--bundle <file>', 'Output bundle (.tgz) path')
  .requiredOption('--allow <file>', 'Proxy allowlist policy YAML')
  .option('--base <tar>', 'Optional base tarball for workspace lower layer')
  .option('--seed <number>', 'Seed value for deterministic RNG', (value) => Number.parseInt(value, 10))
  .addOption(createDeterministicOption())
  .allowUnknownOption(true)
  .argument('<cmd...>', 'Command to execute inside the container')
  .action(async (cmd: string[], options: RecordOptions) => {
    const seed = Number.isFinite(options.seed) ? Number(options.seed) : randomInt(0, Number.MAX_SAFE_INTEGER);
    const startTime = new Date().toISOString();
    const deterministic = options.deterministic ?? true;

    const workspace = await createWorkspace(options.base);
    const proxyArtifacts = await createProxyArtifacts();
    const proxyHandle = await startProxy({
      mode: 'record',
      allowFile: path.resolve(options.allow),
      harPath: proxyArtifacts.harPath,
      caPath: proxyArtifacts.caPath
    });

    let dockerResult: DockerRunResult | undefined;

    try {
      dockerResult = await runDocker({
        image: options.image,
        command: cmd,
        workspacePath: workspace.mountDir,
        seed,
        startTime,
        proxyPort: proxyHandle.port,
        caCertPath: proxyArtifacts.caPath,
        mode: 'record',
        deterministic
      });
    } finally {
      await proxyHandle.stop();
    }

    if (!dockerResult) {
      throw new Error('Docker run did not produce a result');
    }

    const fsDiff = await createFilesystemDiff(workspace);
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
    const clockData = normaliseClockSnapshot(dockerResult.clock, startTime);
    await createBundle(bundleRoot, {
      createdAt: new Date().toISOString(),
      metadata: {
        mode: 'record',
        image: options.image,
        command: cmd,
        seed,
        startTime,
        deterministic,
        workspace: {
          mode: workspace.mode,
          overlayType: workspace.overlayType
        }
      },
      env: {
        seed,
        startTime,
        image: options.image,
        command: cmd,
        deterministic,
        workspace: {
          mode: workspace.mode,
          overlayType: workspace.overlayType
        }
      },
      clock: clockData,
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
  .addOption(createDeterministicOption())
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
      deterministic?: boolean;
    };
    const deterministic = options.deterministic ?? (envData.deterministic ?? true);
    const proxyArtifacts = await createProxyArtifacts();
    const harPath = path.join(extracted.root, manifest.files.network);
    const policyPath = await materialiseLog(extracted.root, manifest.files.logs, 'policy.yaml');
    const caPath = await materialisePrompt(extracted.root, manifest.files.prompts, 'proxy-ca.pem');
    const clockPath = path.join(extracted.root, manifest.files.clock);
    const recordedClock = normaliseClockSnapshot(
      JSON.parse(await readFile(clockPath, 'utf8')) as ClockSnapshot,
      envData.startTime
    );

    const proxyHandle = await startProxy({
      mode: 'replay',
      allowFile: policyPath,
      harPath,
      caPath: proxyArtifacts.caPath
    });

    let dockerResult: DockerRunResult | undefined;
    const workspace = await recreateWorkspace(extracted.root, manifest.files.fsDiff);

    try {
      dockerResult = await runDocker({
        image: envData.image,
        command: envData.command,
        workspacePath: workspace.mountDir,
        seed: envData.seed,
        startTime: envData.startTime,
        proxyPort: proxyHandle.port,
        caCertPath: proxyArtifacts.caPath,
        mode: 'replay',
        deterministic,
        clockData: recordedClock
      });
    } finally {
      await proxyHandle.stop();
    }

    if (!dockerResult) {
      throw new Error('Docker run did not produce a result');
    }

    const fsDiff = await createFilesystemDiff(workspace);
    const diffEntries: Record<string, Buffer | string> = {
      'base.tar': await fs.readFile(workspace.baseTarPath),
      'diff/deleted.json': JSON.stringify(fsDiff.deleted, null, 2)
    };

    for (const entry of fsDiff.files) {
      diffEntries[`diff/files/${entry.relativePath}`] = await fs.readFile(entry.absolutePath);
    }

    const bundleRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-replay-bundle-'));
    const clockData = normaliseClockSnapshot(dockerResult.clock ?? recordedClock, envData.startTime);
    await createBundle(bundleRoot, {
      createdAt: manifest.createdAt ?? new Date().toISOString(),
      metadata: {
        mode: 'replay',
        replayOf: path.resolve(options.bundle),
        image: envData.image,
        command: envData.command,
        seed: envData.seed,
        startTime: envData.startTime,
        deterministic,
        workspace: {
          mode: workspace.mode,
          overlayType: workspace.overlayType
        }
      },
      env: { ...envData, deterministic },
      clock: clockData,
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

async function runDocker(options: RunDockerOptions): Promise<DockerRunResult> {
  const proxyUrl = `http://127.0.0.1:${options.proxyPort}`;
  const envVars = new Map<string, string>([
    ['AGENT_SEED', String(options.seed)],
    ['AGENT_START_TIME', options.startTime],
    ['HTTP_PROXY', proxyUrl],
    ['HTTPS_PROXY', proxyUrl],
    ['ALL_PROXY', proxyUrl],
    ['NODE_EXTRA_CA_CERTS', '/workspace/.agent/ca.pem'],
    ['REQUESTS_CA_BUNDLE', '/workspace/.agent/ca.pem'],
    ['CURL_CA_BUNDLE', '/workspace/.agent/ca.pem'],
    ['AGENT_EXECUTION_MODE', options.mode],
    ['AGENT_CLOCK_FILE', '/workspace/.agent/clock.json']
  ]);

  if (options.deterministic) {
    envVars.set('AGENT_DETERMINISTIC', '1');
    envVars.set('UV_THREADPOOL_SIZE', '1');
    envVars.set('NODE_OPTIONS', mergeEnvValue(process.env.NODE_OPTIONS, '--no-experimental-require-module'));
    envVars.set('GOMAXPROCS', '1');
    envVars.set('JAVA_TOOL_OPTIONS', mergeEnvValue(process.env.JAVA_TOOL_OPTIONS, '-XX:ActiveProcessorCount=1'));
    envVars.set('PYTHONHASHSEED', '0');
    envVars.set('AGENT_CLOCK_MODE', 'deterministic');
  }

  const args = [
    'run',
    '--rm',
    '--network=host',
    '--read-only',
    '--security-opt',
    'no-new-privileges:true',
    '--cap-drop=ALL'
  ];

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

  if (uid !== undefined && gid !== undefined) {
    args.push('--user', `${uid}:${gid}`);
  }

  args.push(
    '--mount',
    `type=bind,src=${options.workspacePath},dst=/workspace,bind-propagation=rprivate`,
    '--tmpfs',
    '/tmp:rw',
    '--tmpfs',
    '/run:rw',
    '--tmpfs',
    '/var/tmp:rw'
  );

  if (options.deterministic) {
    args.push('--cpus=1', '--cpu-shares=1024', '--cpuset-cpus=0');
  }

  for (const [key, value] of envVars) {
    args.push('-e', `${key}=${value}`);
  }

  args.push('-w', '/workspace');

  const commandArgs = [...args, options.image, ...options.command];

  const agentDir = path.join(options.workspacePath, '.agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(options.caCertPath, path.join(agentDir, 'ca.pem'));

  const clockFileHost = path.join(agentDir, 'clock.json');
  await rm(clockFileHost, { force: true });

  if (options.mode === 'replay' && options.clockData) {
    await fs.writeFile(clockFileHost, `${JSON.stringify(options.clockData, null, 2)}\n`, 'utf8');
  }

  const result = await spawnAndCapture('docker', commandArgs, { env: process.env });

  let clock: ClockSnapshot | undefined;
  try {
    const raw = await fs.readFile(clockFileHost, 'utf8');
    clock = JSON.parse(raw) as ClockSnapshot;
  } catch (error) {
    if (options.mode === 'record') {
      clock = normaliseClockSnapshot(undefined, options.startTime);
    } else {
      clock = normaliseClockSnapshot(options.clockData, options.startTime);
    }
  }

  return { ...result, clock: normaliseClockSnapshot(clock, options.startTime) };
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

function mergeEnvValue(existing: string | undefined, value: string): string {
  if (!existing || existing.trim().length === 0) {
    return value;
  }

  if (existing.includes(value)) {
    return existing;
  }

  return `${existing} ${value}`.trim();
}

function normaliseClockSnapshot(clock: ClockSnapshot | undefined, initialTime: string): ClockSnapshot {
  const base = typeof clock === 'object' && clock !== null ? { ...clock } : {};

  if (!('initialTime' in base)) {
    (base as Record<string, unknown>).initialTime = initialTime;
  }

  if (!('version' in base)) {
    (base as Record<string, unknown>).version = 1;
  }

  if (!('sources' in base) || typeof (base as Record<string, unknown>).sources !== 'object') {
    (base as Record<string, unknown>).sources = {};
  }

  return base as ClockSnapshot;
}

async function createWorkspace(baseTar?: string): Promise<WorkspaceInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-'));
  const lowerDir = path.join(root, 'lower');
  await fs.mkdir(lowerDir, { recursive: true });

  if (baseTar) {
    await extractTar(path.resolve(baseTar), lowerDir);
  }

  const baseTarPath = path.join(root, 'base.tar');
  await createTar(lowerDir, baseTarPath);

  return prepareWorkspace(root, lowerDir, baseTarPath);
}

async function recreateWorkspace(bundleRoot: string, fsDiffPath: string): Promise<WorkspaceInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-replay-workspace-'));
  const lowerDir = path.join(root, 'lower');
  await fs.mkdir(lowerDir, { recursive: true });

  const fsDiffRoot = path.join(bundleRoot, fsDiffPath.replace(/\/$/, ''));
  const baseTar = path.join(fsDiffRoot, 'base.tar');
  await extractTar(baseTar, lowerDir);

  const baseTarPath = path.join(root, 'base.tar');
  await fs.copyFile(baseTar, baseTarPath);

  const workspace = await prepareWorkspace(root, lowerDir, baseTarPath);

  const diffFilesDir = path.join(fsDiffRoot, 'diff', 'files');
  const deletedFile = path.join(fsDiffRoot, 'diff', 'deleted.json');

  if (await exists(diffFilesDir)) {
    await applyDiffFiles(diffFilesDir, workspace.mountDir);
  }

  if (await exists(deletedFile)) {
    const raw = await readFile(deletedFile, 'utf8');
    const deleted = JSON.parse(raw) as string[];
    for (const rel of deleted) {
      const target = path.join(workspace.mountDir, rel);
      await rm(target, { recursive: true, force: true });
    }
  }

  return workspace;
}

async function cleanupWorkspace(workspace: WorkspaceInfo) {
  if (workspace.mode === 'overlay') {
    let lastError: Error | undefined;
    const attempts: { command: string; args: string[] }[] = [];

    if (workspace.unmountCommand) {
      attempts.push(workspace.unmountCommand);
    }

    attempts.push({ command: 'umount', args: [workspace.mountDir] });

    for (const attempt of attempts) {
      try {
        await runCommand(attempt.command, attempt.args);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (lastError) {
      console.warn(
        `[agent-run] Failed to unmount overlay workspace ${workspace.mountDir}: ${lastError.message}`
      );
    }
  }

  await rm(workspace.root, { recursive: true, force: true });
}

async function prepareWorkspace(root: string, lowerDir: string, baseTarPath: string): Promise<WorkspaceInfo> {
  if (isLinuxHost()) {
    const upperDir = path.join(root, 'upper');
    const overlayWorkDir = path.join(root, 'overlay-work');
    const mountDir = path.join(root, 'mnt');

    try {
      await fs.mkdir(upperDir, { recursive: true });
      await fs.mkdir(overlayWorkDir, { recursive: true });
      await fs.mkdir(mountDir, { recursive: true });

      const overlayMount = await mountOverlayWorkspace(lowerDir, upperDir, overlayWorkDir, mountDir);

      return {
        root,
        lowerDir,
        mountDir,
        baseTarPath,
        mode: 'overlay',
        upperDir,
        overlayWorkDir,
        unmountCommand: overlayMount.unmountCommand,
        overlayType: overlayMount.type
      };
    } catch (error) {
      const detail = formatOverlayError(error);
      console.warn(
        `[agent-run] OverlayFS unavailable (${detail}); falling back to copy-on-write workspace.`
      );
    }
  } else {
    console.warn('[agent-run] OverlayFS unsupported on this platform; using copy-on-write workspace.');
  }

  const workDir = path.join(root, 'work');
  await fs.mkdir(workDir, { recursive: true });
  await copyLowerToWork(lowerDir, workDir);
  return { root, lowerDir, mountDir: workDir, baseTarPath, mode: 'copy' };
}

function isLinuxHost(): boolean {
  return process.platform === 'linux';
}

interface OverlayMountResult {
  type: 'kernel' | 'fuse';
  unmountCommand: {
    command: string;
    args: string[];
  };
}

async function mountOverlayWorkspace(
  lowerDir: string,
  upperDir: string,
  workDir: string,
  mountDir: string
): Promise<OverlayMountResult> {
  const options = `lowerdir=${lowerDir},upperdir=${upperDir},workdir=${workDir}`;
  const errors: Error[] = [];

  try {
    await runCommand('mount', ['-t', 'overlay', 'overlay', '-o', options, mountDir]);
    return {
      type: 'kernel',
      unmountCommand: { command: 'umount', args: [mountDir] }
    };
  } catch (error) {
    errors.push(error as Error);
  }

  const fuseBinary = await findExecutable(['fuse-overlayfs']);
  if (fuseBinary) {
    try {
      await runCommand(fuseBinary, ['-o', options, mountDir]);
      const fuseUnmountBinary =
        (await findExecutable(['fusermount3'])) ?? (await findExecutable(['fusermount'])) ?? 'fusermount3';
      return {
        type: 'fuse',
        unmountCommand: { command: fuseUnmountBinary, args: ['-u', mountDir] }
      };
    } catch (error) {
      errors.push(error as Error);
    }
  } else {
    errors.push(new Error('fuse-overlayfs executable not found in PATH'));
  }

  throw new AggregateError(errors, 'Failed to mount overlay workspace');
}

function formatOverlayError(error: unknown): string {
  if (error instanceof AggregateError) {
    const messages = error.errors
      .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
      .filter((message) => message.length > 0);
    if (messages.length > 0) {
      return messages.join('; ');
    }
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

async function createFilesystemDiff(workspace: WorkspaceInfo) {
  if (workspace.mode === 'overlay' && workspace.upperDir) {
    return collectOverlayDiff(workspace.upperDir, workspace.lowerDir);
  }

  return createCopyModeDiff(workspace.lowerDir, workspace.mountDir);
}

async function createCopyModeDiff(lowerDir: string, workDir: string) {
  const files: { relativePath: string; absolutePath: string }[] = [];
  const deleted: string[] = [];

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normaliseRelativePath(path.relative(workDir, absolute));
      if (!relative || shouldSkipAgentPath(relative)) {
        if (entry.isDirectory()) {
          await walk(absolute);
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
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
      const relative = normaliseRelativePath(path.relative(lowerDir, absolute));
      if (!relative || shouldSkipAgentPath(relative)) {
        if (entry.isDirectory()) {
          await findDeleted(absolute);
        }
        continue;
      }

      const target = path.join(workDir, relative);
      if (entry.isDirectory()) {
        await findDeleted(absolute);
      } else if (!(await exists(target))) {
        deleted.push(relative);
      }
    }
  };

  await findDeleted(lowerDir);

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  deleted.sort((a, b) => a.localeCompare(b));

  return { files, deleted };
}

async function collectOverlayDiff(upperDir: string, lowerDir: string) {
  const files: { relativePath: string; absolutePath: string }[] = [];
  const deleted = new Set<string>();

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = normaliseRelativePath(path.relative(upperDir, absolute));

      if (entry.name === '.wh..wh..opq') {
        const parentRel = normaliseRelativePath(path.relative(upperDir, dir));
        await collectLowerDeletions(lowerDir, parentRel, deleted);
        continue;
      }

      if (entry.name.startsWith('.wh.')) {
        const parentRel = normaliseRelativePath(path.relative(upperDir, dir));
        const targetName = entry.name.slice(4);
        const targetRel = parentRel ? path.join(parentRel, targetName) : targetName;
        if (!shouldSkipAgentPath(targetRel)) {
          deleted.add(normaliseRelativePath(targetRel));
        }
        continue;
      }

      if ((relative && shouldSkipAgentPath(relative)) || (!relative && entry.name === '.agent')) {
        if (entry.isDirectory()) {
          await walk(absolute);
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (relative) {
          files.push({ relativePath: relative, absolutePath: absolute });
        }
      }
    }
  };

  await walk(upperDir);

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { files, deleted: Array.from(deleted).sort() };
}

function normaliseRelativePath(relativePath: string): string {
  const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join(path.sep);
}

function shouldSkipAgentPath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  const [head] = relativePath.split(path.sep);
  return head === '.agent';
}

async function collectLowerDeletions(lowerDir: string, relativeDir: string, deleted: Set<string>): Promise<void> {
  const baseDir = relativeDir ? path.join(lowerDir, relativeDir) : lowerDir;
  if (!(await exists(baseDir))) {
    return;
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    const nextRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const normalised = normaliseRelativePath(nextRel);
    if (!normalised || shouldSkipAgentPath(normalised)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectLowerDeletions(lowerDir, normalised, deleted);
    } else {
      deleted.add(normalised);
    }
  }
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

async function findExecutable(candidates: string[]): Promise<string | undefined> {
  const searchPaths = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((segment) => segment.length > 0);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (await isExecutable(candidate)) {
        return candidate;
      }
      continue;
    }

    for (const base of searchPaths) {
      const resolved = path.join(base, candidate);
      if (await isExecutable(resolved)) {
        return resolved;
      }
    }
  }

  return undefined;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: string[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const message = stderrChunks.join('').trim();
        const suffix = message.length > 0 ? `: ${message}` : '';
        reject(new Error(`${command} exited with code ${code ?? 0}${suffix}`));
      }
    });
  });
}
