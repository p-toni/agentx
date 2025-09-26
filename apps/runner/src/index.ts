import { Journal } from '@deterministic-agent-lab/journal';
import { DeterministicReplay, createSeededRng } from '@deterministic-agent-lab/replay';

export interface RunnerResult {
  readonly seed: number;
  readonly outputs: readonly string[];
}

export function runAgent(seed: number): RunnerResult {
  const journal = new Journal();
  const rng = createSeededRng(seed);

  const bundle = {
    id: `seed-${seed}`,
    events: Array.from({ length: 3 }, (_, index) => ({
      timestamp: index,
      channel: 'rng',
      data: rng().toFixed(5)
    }))
  };

  const replay = new DeterministicReplay(bundle);
  const outputs: string[] = [];
  replay.play((event) => {
    const message = `${event.channel}:${event.data}`;
    outputs.push(message);
    journal.add({
      id: `${bundle.id}-${event.timestamp}`,
      timestamp: event.timestamp,
      type: 'rng-sample',
      payload: { value: event.data }
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
