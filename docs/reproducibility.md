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
