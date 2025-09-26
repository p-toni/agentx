import { Journal } from '@deterministic-agent-lab/journal';

export interface EchoInput {
  readonly message: string;
}

export interface EchoResult {
  readonly echoed: string;
  readonly journalSize: number;
}

export function runEchoAgent(input: EchoInput): EchoResult {
  const journal = new Journal();
  const normalized = input.message.trim();

  journal.add({
    id: 'echo-1',
    timestamp: Date.now(),
    type: 'echo',
    payload: { normalized }
  });

  return {
    echoed: normalized,
    journalSize: journal.list().length
  };
}
