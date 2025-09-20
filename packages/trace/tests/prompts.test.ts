import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PromptParams,
  PromptRecording,
  PromptTraceStore,
  PromptTokenEvent,
  serialisePromptRecording
} from '../src';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe('PromptTraceStore', () => {
  it('records prompt events to disk with sequential names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prompt-store-record-'));
    tempDirs.push(directory);

    const store = new PromptTraceStore({ directory, mode: 'record' });
    const params: PromptParams = { temperature: 0.1, top_p: 0.9 };
    const tokens: PromptTokenEvent[] = [
      { index: 0, token: 'H', timestamp: '2024-01-01T00:00:00.000Z' },
      { index: 1, token: 'i', timestamp: '2024-01-01T00:00:00.100Z' }
    ];

    const recording: PromptRecording = {
      type: 'llm.call',
      provider: 'openai',
      model: 'gpt-test',
      params,
      prompt: {
        type: 'chat',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Say hi' }
        ]
      },
      response: {
        completion: 'Hi',
        tokens,
        finishReason: 'stop'
      },
      timings: {
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:00:01.000Z'
      }
    };

    const firstPath = await store.recordPrompt(recording);
    expect(firstPath).toBe(join(directory, '0001.json'));

    const secondPath = await store.recordPrompt(recording);
    expect(secondPath).toBe(join(directory, '0002.json'));

    const raw = await readFile(firstPath, 'utf8');
    expect(raw.trim()).toEqual(serialisePromptRecording(recording));
  });

  it('replays recorded prompts sequentially', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prompt-store-replay-'));
    tempDirs.push(directory);

    const store = new PromptTraceStore({ directory, mode: 'record' });
    const recording: PromptRecording = {
      type: 'llm.call',
      provider: 'openai',
      model: 'gpt-test',
      params: {},
      prompt: {
        type: 'chat',
        messages: [{ role: 'user', content: 'Test' }]
      },
      response: {
        completion: 'Result',
        tokens: [{ index: 0, token: 'R', timestamp: '2024-01-01T00:00:00.000Z' }]
      },
      timings: {
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:00:01.000Z'
      }
    };

    await store.recordPrompt(recording);

    const replayStore = new PromptTraceStore({ directory, mode: 'replay' });
    const replayed = await replayStore.consumePrompt();
    expect(replayed.response.completion).toBe('Result');
    expect(replayed.response.tokens).toHaveLength(1);
  });
});
