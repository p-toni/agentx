import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PromptRecording, PromptTokenEvent } from '@deterministic-agent-lab/trace';
import { PromptTraceStore, serialisePromptRecording } from '@deterministic-agent-lab/trace';
import {
  Journal,
  LlmCallDriver,
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResult,
  OpenAICompatibleProvider
} from '../src';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
});

describe('LlmCallDriver', () => {
  it('records provider output and token stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llm-record-'));
    tempDirs.push(directory);

    const clock = (() => {
      let current = Date.parse('2024-01-01T00:00:00.000Z');
      return () => new Date(current += 1000);
    })();

    const recorder = new PromptTraceStore({ directory, mode: 'record' });

    const provider: LlmProvider = {
      async call(request: LlmProviderRequest): Promise<LlmProviderResult> {
        return {
          id: 'resp-1',
          model: request.model,
          completion: 'Hello world',
          finishReason: 'stop'
        };
      }
    };

    const driver = new LlmCallDriver({ provider, recorder, clock });
    const journal = new Journal({ filePath: join(directory, 'journal.jsonl'), clock });

    const intent = {
      type: 'llm.call',
      idempotencyKey: 'llm-1',
      payload: {
        provider: 'openai',
        model: 'gpt-test',
        prompt: {
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Say hello.' }
          ]
        },
        params: {
          temperature: 0.2,
          top_p: 0.9
        }
      }
    } as const;

    const entry = await journal.append(intent, driver);
    expect(entry.receipt?.source).toBe('record');
    expect(entry.receipt?.completion).toBe('Hello world');
    expect(entry.receipt?.tokens.length).toBeGreaterThan(0);

    const recorded = JSON.parse(await readFile(join(directory, '0001.json'), 'utf8')) as PromptRecording;
    expect(recorded.provider).toBe('openai');
    expect(recorded.model).toBe('gpt-test');
    expect(recorded.params.temperature).toBe(0.2);
    expect(recorded.response.tokens.map((t) => t.token).join('')).toBe('Hello world');
  });

  it('replays recorded response without calling provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llm-replay-'));
    tempDirs.push(directory);

    const tokens: PromptTokenEvent[] = [
      { index: 0, token: 'O', timestamp: '2024-01-01T00:00:00.000Z' },
      { index: 1, token: 'K', timestamp: '2024-01-01T00:00:00.500Z' }
    ];

    const recording: PromptRecording = {
      type: 'llm.call',
      provider: 'openai',
      model: 'gpt-test',
      params: {},
      prompt: {
        type: 'chat',
        messages: [{ role: 'user', content: 'Ping?' }]
      },
      response: {
        completion: 'OK',
        tokens
      },
      timings: {
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:00:01.000Z'
      }
    };

    await writeFile(join(directory, '0001.json'), `${serialisePromptRecording(recording)}\n`, 'utf8');

    const provider = {
      call: vi.fn(async () => {
        throw new Error('provider should not be called in replay mode');
      })
    } satisfies LlmProvider;

    const recorder = new PromptTraceStore({ directory, mode: 'replay' });
    const driver = new LlmCallDriver({ provider, recorder });
    const journal = new Journal({ filePath: join(directory, 'journal.jsonl') });

    const intent = {
      type: 'llm.call',
      idempotencyKey: 'llm-2',
      payload: {
        provider: 'openai',
        model: 'gpt-test',
        prompt: {
          messages: [{ role: 'user', content: 'Ping?' }]
        }
      }
    } as const;

    const entry = await journal.append(intent, driver);
    expect(entry.receipt?.source).toBe('replay');
    expect(entry.receipt?.completion).toBe('OK');
    expect(entry.receipt?.tokens).toEqual(tokens);
    expect(provider.call).not.toHaveBeenCalled();
  });
});

describe('OpenAICompatibleProvider', () => {
  it('calls fetch with expected payload', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Hello there' }
            }
          ]
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl
    });

    const result = await provider.call({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hi' }],
      params: { temperature: 0 }
    });

    expect(result.completion).toBe('Hello there');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0] ?? [];
    expect(options?.headers?.Authorization).toBe('Bearer test-key');
  });
});
