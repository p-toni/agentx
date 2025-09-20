import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
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
