# deterministic-agent-lab

A pnpm + TypeScript monorepo for building deterministic agent tooling, including journal, proxy, trace, and replay packages plus runner and gate applications.

## Workspace layout

- `packages/journal` — shared intent log models and driver SDK helpers.
- `packages/proxy` — HTTP(S) allowlist proxy with record/replay hooks.
- `packages/trace` — trace bundle format definitions with readers/writers.
- `packages/replay` — deterministic replay utilities for network, clock, and RNG.
- `apps/runner` — CLI entrypoint to run an agent inside a controlled container.
- `apps/gate-api` — Fastify API surface for plan/approve/commit/revert flows.
- `apps/gate-ui` — Next.js interface for reviewing diffs and approvals.
- `examples/agents/echo` — toy agent used for end-to-end tests.

## Getting started

1. Install dependencies (Node 20+ is required):

   ```bash
   corepack enable pnpm
   pnpm install
   ```

2. Run development mode across workspaces:

   ```bash
   pnpm dev
   ```

3. Build, lint, and test:

   ```bash
   pnpm build
   pnpm lint
   pnpm test
   ```

### Makefile shortcuts

- `make up` — alias for `pnpm dev`.
- `make test` — alias for `pnpm test`.
- `make e2e` — runs example echo agent tests.

## Tooling

- TypeScript strict configuration shared through `tsconfig.base.json`.
- ESLint with `@typescript-eslint` rules.
- Vitest for unit and integration tests.
- Turborepo orchestrates build/lint/test/dev pipelines with caching.
- Devcontainer preconfigures Ubuntu, Node 20, Docker-in-Docker, and pnpm.

## Continuous Integration

GitHub Actions workflow installs pnpm, restores pnpm/Turborepo caches, and runs `pnpm lint`, `pnpm build`, and `pnpm test` on every push and pull request.
