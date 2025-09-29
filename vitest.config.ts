import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...segments: string[]) => resolve(rootDir, ...segments);

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '@deterministic-agent-lab/trace': fromRoot('packages/trace/src/index.ts'),
      '@deterministic-agent-lab/journal': fromRoot('packages/journal/src/index.ts'),
      '@deterministic-agent-lab/replay': fromRoot('packages/replay/src/index.ts')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'examples/**/tests/**/*.test.ts'
    ]
  }
});
