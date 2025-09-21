import { openBundle as openTraceBundle, type TraceBundle, type IntentRecord } from '@deterministic-agent-lab/trace';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedIntent } from './bundle';

export async function openBundle(root: string): Promise<TraceBundle> {
  return openTraceBundle(root);
}

export async function loadBundleIntents(bundle: TraceBundle, root: string): Promise<LoadedIntent[]> {
  const intentsPath = path.join(root, bundle.manifest.files.intents);
  const raw = await readFile(intentsPath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const intents: IntentRecord[] = lines.map((line) => JSON.parse(line) as IntentRecord);
  return intents.map((intent, index) => ({
    index,
    type: intent.intent,
    timestamp: intent.timestamp,
    payload: intent.payload,
    metadata: extractMetadata(intent),
    raw: intent as unknown as Record<string, unknown>
  }));
}

function extractMetadata(intent: IntentRecord): Record<string, unknown> | undefined {
  const record = intent as Record<string, unknown>;
  if (!record.metadata || typeof record.metadata !== 'object') {
    return undefined;
  }
  return record.metadata as Record<string, unknown>;
}
