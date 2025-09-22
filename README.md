# deterministic-agent-lab

A pnpm + TypeScript monorepo for building deterministic agent tooling, including journal, proxy, trace, and replay packages plus runner and gate applications.

## Workspace layout

- `packages/journal` — shared intent log models and driver SDK helpers.
- `packages/proxy` — HTTP(S) allowlist proxy with record/replay hooks.
- `packages/trace` — trace bundle format definitions with readers/writers.
- `packages/replay` — deterministic replay utilities (includes `replay verify` CLI plus Node/Python helpers for virtual clocks).
- `metrics/` — reproducibility metrics harness and reporting CLI.
- `apps/runner` — CLI entrypoint to run an agent inside a controlled container.
- `apps/gate-api` — Fastify API surface for plan/approve/commit/revert flows.
- `apps/gate-ui` — Next.js interface for reviewing diffs and approvals.
- `policy/` — Rego sources, Wasm bundle, and unit tests for gate policy enforcement.
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

See [`docs/reproducibility.md`](docs/reproducibility.md) for a deeper look at the deterministic
architecture and how replay guarantees are measured in CI.

### Deterministic runner

The `agent-run` CLI orchestrates fully deterministic executions inside Docker. It
spawns the proxy (record or replay), wires `HTTP(S)_PROXY` for the container,
seeds RNG/clock (`AGENT_SEED`, `AGENT_START_TIME`), snapshots filesystem diffs,
and emits a trace bundle (`.tgz`).

```
# Record
pnpm --filter @deterministic-agent-lab/runner build
node apps/runner/dist/agent-run.js record \
  --image node:20-alpine \
  --bundle /tmp/echo-record.tgz \
  --allow policy.yaml \
  --base base.tar \
  --seed 42 \
  node echo.js "  hello  "

# Replay (bundle hashes can be compared via @deterministic-agent-lab/trace)
node apps/runner/dist/agent-run.js replay \
  --bundle /tmp/echo-record.tgz \
  --output /tmp/echo-replay.tgz
```

Node agents can import `apps/runner/src/fake-clock` and call
`installFakeClock()` on bootstrap to ensure `Date.now()` and zero-argument
`new Date()` are derived from `AGENT_START_TIME` instead of wall-clock time.

## Continuous Integration

GitHub Actions workflow installs pnpm, restores pnpm/Turborepo caches, and runs `pnpm lint`, `pnpm build`, and `pnpm test` on every push and pull request.
