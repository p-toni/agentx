#!/usr/bin/env node
import { Command } from 'commander';
import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import fs from 'fs-extra';
import { execa } from 'execa';
import { performance } from 'node:perf_hooks';
import { openBundle, type TraceBundle } from '@deterministic-agent-lab/trace';
import { verifyBundle, type ReplayVerificationResult } from '@deterministic-agent-lab/replay';

const { mkdtemp, writeFile, rm, readdir, stat } = fsPromises;
const ROOT = path.resolve(__dirname, '..', '..');

interface RunMetrics {
  seed: number;
  success: boolean;
  coverage: boolean;
  replayTimeMs: number | null;
  error?: string;
}

const DEFAULT_ITERATIONS = 50;
const REPORT_DIR = path.join(ROOT, 'metrics', 'reports');
const REPORT_DEFAULT = path.join(REPORT_DIR, 'replay-metrics.md');
const RUNNER_CLI = path.join(ROOT, 'apps', 'runner', 'dist', 'agent-run.js');

const program = new Command();

program
  .name('metrics')
  .description('Collect reproducibility metrics for deterministic-agent-lab');

program
  .command('replay')
  .description('Run reproducibility experiments against the echo agent')
  .option('-n, --iterations <number>', 'Number of random seeds to evaluate', String(DEFAULT_ITERATIONS))
  .option('-o, --output <path>', 'Report output path', REPORT_DEFAULT)
  .option('--image <image>', 'Container image for the agent run', 'node:20-alpine')
  .action(async (options) => {
    const iterations = Math.max(1, Number.parseInt(options.iterations ?? String(DEFAULT_ITERATIONS), 10));
    const outputPath = path.resolve(ROOT, options.output ?? REPORT_DEFAULT);
    const image = String(options.image ?? 'node:20-alpine');

    await fs.ensureDir(path.dirname(outputPath));

    const runnerExists = await fileExists(RUNNER_CLI);
    if (!runnerExists) {
      console.error('apps/runner/dist/agent-run.js not found. Please run "pnpm build" first.');
      process.exit(1);
    }

    if (!(await hasDocker())) {
      console.error('Docker is required to collect reproducibility metrics.');
      process.exit(1);
    }

    const results: RunMetrics[] = [];

    for (let i = 0; i < iterations; i += 1) {
      const seed = randomInt(1, 2 ** 31 - 1);
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'metrics-run-'));
      try {
        const context = await prepareRecordingWorkspace(workspace);
        await recordBundle(context, seed, image);
        const coverage = await checkBoundaryCoverage(context.recordBundle);

        let success = false;
        let replayTimeMs: number | null = null;
        let error: string | undefined;

        try {
          const start = performance.now();
          const verification = await verifyBundle({ bundlePath: context.recordBundle, quiet: true });
          replayTimeMs = performance.now() - start;
          success = verification.success;
          if (!verification.success) {
            error = formatVerificationError(verification);
          }
        } catch (verifyError) {
          error = (verifyError as Error).message;
        }

        results.push({ seed, success, coverage, replayTimeMs, error });
      } finally {
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const report = buildReport(results, iterations);
    await fs.writeFile(outputPath, report, 'utf8');
    console.log(`Replay metrics written to ${outputPath}`);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

enum Component {
  Env = 'env',
  Clock = 'clock',
  Network = 'network',
  Prompts = 'prompts'
}

interface RecordingContext {
  root: string;
  scriptPath: string;
  baseTar: string;
  policyPath: string;
  recordBundle: string;
}

async function prepareRecordingWorkspace(root: string): Promise<RecordingContext> {
  const scriptPath = path.join(root, 'echo.js');
  await writeFile(
    scriptPath,
    `const fs = require('fs');\nconst input = process.argv.slice(2).join(' ');\nconst trimmed = input.trim();\nfs.writeFileSync('echo.txt', trimmed + '\\n');\nconsole.log(JSON.stringify({ echoed: trimmed }));\n`
  );

  const baseTar = path.join(root, 'base.tar');
  await execa('tar', ['-cf', baseTar, '-C', root, 'echo.js']);

  const policyPath = path.join(root, 'policy.yaml');
  await writeFile(
    policyPath,
    `rules:\n  - host: 127.0.0.1:80\n    methods: ['GET']\n`
  );

  const recordBundle = path.join(root, 'record.tgz');
  return { root, scriptPath, baseTar, policyPath, recordBundle };
}

async function recordBundle(context: RecordingContext, seed: number, image: string): Promise<void> {
  await execa('node', [
    RUNNER_CLI,
    'record',
    '--image',
    image,
    '--bundle',
    context.recordBundle,
    '--allow',
    context.policyPath,
    '--base',
    context.baseTar,
    '--seed',
    String(seed),
    'node',
    path.basename(context.scriptPath),
    '  hello  '
  ], {
    cwd: context.root,
    stdio: 'inherit'
  });
}

async function checkBoundaryCoverage(bundlePath: string): Promise<boolean> {
  const extractDir = await mkdtemp(path.join(os.tmpdir(), 'metrics-bundle-'));
  try {
    await execa('tar', ['-xzf', bundlePath, '-C', extractDir]);
    const bundle = await openBundle(extractDir);
    return hasComponent(bundle, extractDir, Component.Env) &&
      hasComponent(bundle, extractDir, Component.Clock) &&
      hasComponent(bundle, extractDir, Component.Network) &&
      hasComponent(bundle, extractDir, Component.Prompts);
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function hasComponent(bundle: TraceBundle, extractDir: string, component: Component): boolean {
  const relative = bundle.manifest.files[component];
  if (!relative) {
    return false;
  }
  const cleaned = relative.replace(/\/$/, '');
  const absolute = path.join(extractDir, cleaned);
  return fs.existsSync(absolute) && hasContent(absolute);
}

function hasContent(target: string): boolean {
  try {
    const stats = fs.statSync(target);
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(target);
      return entries.length > 0;
    }
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function formatVerificationError(result: ReplayVerificationResult): string {
  if (result.stdoutDiff) {
    return result.stdoutDiff.message;
  }
  if (result.stderrDiff) {
    return result.stderrDiff.message;
  }
  return `exit_code=${result.exitCode}`;
}

function buildReport(results: RunMetrics[], iterations: number): string {
  const total = results.length;
  const successCount = results.filter((run) => run.success).length;
  const coverageCount = results.filter((run) => run.coverage).length;
  const replayDurations = results.filter((run) => run.replayTimeMs != null).map((run) => run.replayTimeMs ?? 0);
  const meanReplay = replayDurations.length > 0
    ? replayDurations.reduce((sum, value) => sum + value, 0) / replayDurations.length
    : 0;

  const lines: string[] = [];
  lines.push('# Replay Determinism Metrics');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total runs: ${total}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| replay_fidelity | ${(successCount / Math.max(1, total)).toFixed(3)} |`);
  lines.push(`| boundary_coverage | ${(coverageCount / Math.max(1, total)).toFixed(3)} |`);
  lines.push(`| mean_revert_time_ms | ${meanReplay.toFixed(2)} |`);
  lines.push('');
  lines.push('## Runs');
  lines.push('| # | Seed | Success | Coverage | Replay Time (ms) | Error |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  results.forEach((run, index) => {
    lines.push(
      `| ${index + 1} | ${run.seed} | ${run.success ? 'yes' : 'no'} | ${run.coverage ? 'yes' : 'no'} | ${run.replayTimeMs != null ? run.replayTimeMs.toFixed(2) : 'n/a'} | ${run.error ? escapePipes(run.error) : ''} |`
    );
  });

  lines.push('');
  lines.push('> mean_revert_time_ms captures the average duration of deterministic replay validations.');

  return `${lines.join('\n')}\n`;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasDocker(): Promise<boolean> {
  let tempDir: string | undefined;
  try {
    await execa('docker', ['version'], { stdio: 'ignore' });
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'metrics-docker-check-'));
    await execa(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${tempDir}:/workspace`,
        'node:20-alpine',
        'sh',
        '-c',
        'echo ok > /workspace/check'
      ],
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
