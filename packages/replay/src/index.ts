import type { IntentRecord, TraceBundle } from '@deterministic-agent-lab/trace';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export type ReplayHandler = (intent: IntentRecord) => void;

export class DeterministicReplay {
  constructor(private readonly intents: readonly IntentRecord[]) {}

  static async fromBundle(bundle: TraceBundle): Promise<DeterministicReplay> {
    const intents = await loadIntents(bundle);
    return new DeterministicReplay(intents);
  }

  play(handler: ReplayHandler): void {
    const ordered = [...this.intents].sort((left, right) =>
      compareTimestamp(left.timestamp, right.timestamp)
    );

    for (const intent of ordered) {
      handler(intent);
    }
  }
}

export async function loadIntents(bundle: TraceBundle): Promise<IntentRecord[]> {
  const intentsPath = join(bundle.root, bundle.manifest.files.intents);
  const raw = await fs.readFile(intentsPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IntentRecord);
}

function compareTimestamp(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return leftTime - rightTime;
  }

  return left.localeCompare(right);
}

export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}
