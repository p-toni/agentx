# Reproducibility Guarantees

The deterministic-agent-lab toolkit captures every agent execution as a signed trace
bundle.  During recording we proxy outbound network traffic, seed the runtime clock
and RNG, and snapshot filesystem mutations.  Each replay rehydrates that bundle inside
a fresh container and routes traffic through a strict allow proxy, so diverging side
effects translate into observable drift.

## Architecture Overview

1. **Recording path** – the `agent-run record` command launches the agent inside a
   Docker sandbox with seeded environment variables.  A transparent proxy records
   HAR traces while filesystem overlays collect a tarball of every changed path.  The
   resulting bundle contains:
   - `env.json` – seeded RNG/clock and runtime metadata;
   - `clock.json` – monotonic tick data;
   - `network.har` – canonicalised HTTP transcripts;
   - `prompts/` – any LLM prompt/response payloads;
   - `fs-diff/` – changed and deleted files;
   - `logs/` – stdout, stderr, and policy material.

2. **Replay path** – the `agent-run replay` command consumes the bundle, restores the
   overlay filesystem, replays the recorded HAR through the proxy, and re-runs the agent
   with the original seed/time.  Any divergence in stdout/stderr, captured receipts, or
   proxy traffic immediately surfaces during verification.

3. **Policy enforcement** – Gate API evaluates Rego-based policies (compiled to Wasm)
   during plan/commit and feeds the Gate UI for human approval.  Approvals bundle the
   policy version for auditability.

## Measuring Guarantees

The `@deterministic-agent-lab/metrics` package continuously measures replay fidelity by
re-running the echo agent under random seeds.  For each execution we:

- record a bundle via `agent-run record`;
- verify deterministic replay via the metrics verifier (`replay_fidelity`);
- assert that critical bundle components (`env`, `clock`, `network`, `prompts`) are
  present (`boundary_coverage`);
- time the replay validation, which approximates the effort required to “revert” an
  execution using our reversible HTTP twin (`mean_revert_time_ms`).

A Markdown report summarises aggregate statistics and per-run outcomes.  This report is
archived on every CI run so regressions become visible immediately.

## Concurrency

By default the runner enables deterministic scheduling (`--deterministic`). Each
container is pinned to a single logical CPU (`--cpus=1` and `--cpuset-cpus=0`) and we
export guard rails per runtime:

- `UV_THREADPOOL_SIZE=1` and `NODE_OPTIONS=--no-experimental-require-module` for Node;
- `GOMAXPROCS=1` for Go; `-XX:ActiveProcessorCount=1` for Java;
- `PYTHONHASHSEED=0` for Python.

Every execution also receives `AGENT_CLOCK_FILE`, `AGENT_EXECUTION_MODE`, and
`AGENT_DETERMINISTIC=1`. Agents can opt in to fully deterministic timers/RNG by loading
the lightweight shims:

- Node: `node -r @deterministic-agent-lab/runtime-node/register app.js`
- Python: `python -m dal_runtime app.py`

These preloads install a virtual clock, seeded PRNG, and deterministic timer scheduler.
During recording they emit `clock.json` ticks (per runtime source) which are replayed to
enforce identical event ordering. The runner persists those ticks in the trace bundle so
replays can verify byte-for-byte output stability.

## Filesystem Isolation

`agent-run` confines workspace writes by mounting a private OverlayFS union when running
on Linux. The lowerdir tracks the seeded base tarball, while all runtime mutations land in
an upperdir that is copied verbatim into the trace bundle (`fs-diff/`). Containers execute
with `--read-only` roots, `--cap-drop=ALL`, only `/workspace` is writable, and tmpfs mounts
cover `/tmp`, `/run`, and `/var/tmp` for scratch space. Whenever possible the container runs
as the invoking UID/GID so host permissions line up across the bind mount. Attempts to write
outside the workspace (for example `/etc` or `$HOME`) fail with `EROFS`/`EACCES` and are
surfaced as non-zero exits during record. When the host cannot mount OverlayFS (e.g. macOS),
the runner falls back to its previous copy-on-write mirrors and logs a warning so operators
can audit the reduced isolation guarantees.
