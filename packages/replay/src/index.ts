import type { TraceBundle, TraceEvent } from '@deterministic-agent-lab/trace';

export type ReplayHandler = (event: TraceEvent) => void;

export class DeterministicReplay {
  constructor(private readonly bundle: TraceBundle) {}

  play(handler: ReplayHandler): void {
    const ordered = [...this.bundle.events].sort(
      (left, right) => left.timestamp - right.timestamp
    );

    for (const event of ordered) {
      handler(event);
    }
  }
}

export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}
