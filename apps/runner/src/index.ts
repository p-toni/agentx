import { Journal } from '@deterministic-agent-lab/journal';
import { DeterministicReplay, createSeededRng } from '@deterministic-agent-lab/replay';

export interface RunnerResult {
  readonly seed: number;
  readonly outputs: readonly string[];
}

export function runAgent(seed: number): RunnerResult {
  const journal = new Journal();
  const rng = createSeededRng(seed);

  const bundleId = `seed-${seed}`;
  const intents = Array.from({ length: 3 }, (_, index) => ({
    timestamp: new Date(index * 1000).toISOString(),
    intent: 'rng.sample',
    payload: {
      value: rng().toFixed(5),
      sequence: index
    }
  }));

  const replay = new DeterministicReplay(intents);
  const outputs: string[] = [];
  replay.play((intent) => {
    const payload = (intent.payload && typeof intent.payload === 'object'
      ? intent.payload
      : {}) as Record<string, unknown>;
    const value = typeof payload.value === 'string' ? payload.value : String(payload.value ?? '');
    const sequence = typeof payload.sequence === 'number' ? payload.sequence : outputs.length;

    const message = `rng:${value}`;
    outputs.push(message);
    journal.add({
      id: `${bundleId}-${intent.timestamp}`,
      timestamp: sequence,
      type: 'rng-sample',
      payload: { value }
    });
  });

  return { seed, outputs };
}

if (require.main === module) {
  const [, , seedArg] = process.argv;
  const seed = Number(seedArg ?? '1');
  const result = runAgent(seed);
  console.log(JSON.stringify(result, null, 2));
}
