#!/usr/bin/env node
import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import process from 'node:process';
import { verifyBundle } from './bundle-verify';

const program = new Command();

program
  .name('replay')
  .description('Deterministic bundle replay utilities');

program
  .command('verify')
  .description('Replay a recorded bundle and compare captured outputs')
  .argument('<bundle>', 'Path to the recorded trace bundle (.tgz)')
  .addOption(new Option('--docker <command>', 'Docker CLI to use').default('docker'))
  .option('--keep-workspace', 'Preserve the reconstructed workspace for inspection', false)
  .option('--quiet', 'Suppress proxy output noise', false)
  .option('--env <key=value...>', 'Extra environment variables for the replay container', collectEnv, {})
  .action(async (bundle, options) => {
    if (options.quiet) {
      process.env.REPLAY_SILENT_PROXY = '1';
    }

    try {
      const result = await verifyBundle({
        bundlePath: resolve(bundle),
        dockerCommand: options.docker,
        additionalEnv: options.env,
        keepWorkspace: options.keepWorkspace,
        quiet: options.quiet
      });

      if (result.success) {
        console.log('Replay verification succeeded.');
        if (result.workspacePath) {
          console.log(`Workspace preserved at ${result.workspacePath}`);
        }
        process.exit(0);
      }

      console.error('Replay verification failed.');
      console.error(`Exit code: ${result.exitCode}`);
      if (result.stdoutDiff) {
        console.error(`\nSTDOUT mismatch: ${result.stdoutDiff.message}`);
      }
      if (result.stderrDiff) {
        console.error(`\nSTDERR mismatch: ${result.stderrDiff.message}`);
      }
      if (result.workspacePath) {
        console.error(`Workspace preserved at ${result.workspacePath}`);
      }
      process.exit(1);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function collectEnv(value: string, previous: Record<string, string>): Record<string, string> {
  const result = { ...previous };
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const [key, ...rest] = entry.split('=');
    if (!key || rest.length === 0) {
      throw new Error(`Invalid --env value: ${entry}. Expected KEY=VALUE.`);
    }
    result[key] = rest.join('=');
  }
  return result;
}
