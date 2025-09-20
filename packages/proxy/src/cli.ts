#!/usr/bin/env node
import { Command } from 'commander';
import { loadPolicy } from './policy';
import { EgressProxy, ProxyMode } from './proxy-server';

const program = new Command();

program
  .name('egress-proxy')
  .description('Deterministic Agent Lab HTTP(S) proxy for recording and replaying egress traffic')
  .requiredOption('--mode <mode>', 'proxy mode: record | replay | passthrough')
  .requiredOption('--allow <file>', 'YAML policy allowlist file')
  .requiredOption('--har <file>', 'HAR capture file path')
  .requiredOption('--ca <file>', 'output path for generated CA certificate (PEM)')
  .option('--port <number>', 'port to listen on', toInteger)
  .option('--host <host>', 'host/interface to bind', '127.0.0.1')
  .option('--ssl-cache <dir>', 'directory for generated certificates cache')
  .action(async (options) => {
    const mode = normalizeMode(options.mode);
    const policy = await loadPolicy(options.allow);
    const proxy = new EgressProxy({
      mode,
      policy,
      harPath: options.har,
      caCertPath: options.ca,
      listenHost: options.host,
      listenPort: options.port,
      sslCacheDir: options.sslCache
    });

    try {
      const result = await proxy.start();
      console.log(`egress proxy listening on http://${result.host}:${result.port}`);
      console.log(`trust the generated CA certificate at: ${result.caCertPath}`);
      console.log(`mode: ${mode}`);

      const shutdown = async () => {
        console.log('Stopping proxy...');
        await proxy.stop();
        const blocked = proxy.getBlockedRequests();
        if (blocked.length > 0) {
          console.log(`Blocked ${blocked.length} request(s):`);
          for (const item of blocked) {
            console.log(` - ${item.method} ${item.url} (${item.reason})`);
          }
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error(`Failed to start proxy: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});

function normalizeMode(value: string): ProxyMode {
  const mode = value.toLowerCase();
  if (mode !== 'record' && mode !== 'replay' && mode !== 'passthrough') {
    throw new Error(`Invalid mode ${value}`);
  }
  return mode;
}

function toInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer but received ${value}`);
  }
  return parsed;
}
