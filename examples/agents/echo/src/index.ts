import type { Driver } from '@deterministic-agent-lab/journal';
import { Journal } from '@deterministic-agent-lab/journal';

export interface EchoInput {
  readonly message: string;
}

export interface EchoResult {
  readonly echoed: string;
  readonly journalSize: number;
}

export interface EchoAgentOptions {
  readonly journal?: Journal;
}

interface EchoPayload {
  readonly normalized: string;
}

interface EchoReceipt {
  readonly recorded: true;
}

const echoDriver: Driver<EchoPayload, EchoReceipt, void> = {
  async prepare() {
    return undefined;
  },
  async commit() {
    return { recorded: true } as const;
  },
  async rollback() {
    // nothing to roll back for in-memory bookkeeping
  }
};

export async function runEchoAgent(
  input: EchoInput,
  options: EchoAgentOptions = {}
): Promise<EchoResult> {
  const journal = options.journal ?? new Journal();
  const normalized = input.message.trim();

  await journal.append(
    {
      type: 'echo.record',
      idempotencyKey: `echo-${normalized}`,
      payload: { normalized }
    },
    echoDriver
  );

  return {
    echoed: normalized,
    journalSize: journal.list().length
  };
}
