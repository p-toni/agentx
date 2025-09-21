import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openBundle, type TraceBundle, loadBundleIntents } from './trace-utils';

export interface NetworkEntrySummary {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
}

export interface PlanSummary {
  readonly bundle: TraceBundle;
  readonly intents: LoadedIntent[];
  readonly fsDiff: FileDiffSummary;
  readonly network: NetworkEntrySummary[];
}

export interface LoadedIntent {
  readonly index: number;
  readonly type: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export interface FileDiffSummary {
  readonly changed: string[];
  readonly deleted: string[];
}

export async function loadPlanSummary(bundlePath: string): Promise<PlanSummary> {
  const extraction = await extractBundle(bundlePath);
  try {
    const bundle = await openBundle(extraction.root);
    const intents = await loadBundleIntents(bundle, extraction.root);
    const fsDiff = await readFsDiff(bundle, extraction.root);
    const network = await readNetworkEntries(bundle, extraction.root);
    return { bundle, intents, fsDiff, network };
  } finally {
    await rm(extraction.root, { recursive: true, force: true });
  }
}

async function extractBundle(bundlePath: string): Promise<{ root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'gate-bundle-'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', bundlePath, '-C', root]);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? 0}`));
      }
    });
  });
  return { root };
}

async function readFsDiff(bundle: TraceBundle, root: string): Promise<FileDiffSummary> {
  const fsDiffRoot = path.join(root, bundle.manifest.files.fsDiff.replace(/\/$/, ''));
  const changedDir = path.join(fsDiffRoot, 'diff', 'files');
  const deletedFile = path.join(fsDiffRoot, 'diff', 'deleted.json');

  const changed: string[] = [];
  try {
    const entries = await listFiles(changedDir, changedDir);
    changed.push(...entries);
  } catch {
    // ignore missing diff files
  }

  let deleted: string[] = [];
  try {
    const raw = await readFile(deletedFile, 'utf8');
    deleted = JSON.parse(raw) as string[];
  } catch {
    deleted = [];
  }

  return {
    changed: changed.sort(),
    deleted: deleted.sort()
  };
}

async function readNetworkEntries(bundle: TraceBundle, root: string): Promise<NetworkEntrySummary[]> {
  const networkPath = path.join(root, bundle.manifest.files.network);
  try {
    const raw = await readFile(networkPath, 'utf8');
    const har = JSON.parse(raw) as { log?: { entries?: Array<{ request?: { method?: string; url?: string; headers?: Array<{ name: string; value: string }> } }> } };
    const entries = har.log?.entries ?? [];
    return entries
      .map((entry) => {
        const method = (entry.request?.method ?? 'GET').toUpperCase();
        const url = entry.request?.url ?? '';
        const headers = Object.fromEntries((entry.request?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
        return { url, method, headers };
      })
      .filter((entry) => entry.url.length > 0);
  } catch {
    return [];
  }
}

async function listFiles(root: string, base: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    const dirents = await readDirRecursive(root, base);
    entries.push(...dirents);
  } catch {
    // ignore
  }
  return entries;
}

async function readDirRecursive(current: string, base: string): Promise<string[]> {
  const results: string[] = [];
  const dirents = await readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    const abs = path.join(current, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...(await readDirRecursive(abs, base)));
    } else if (dirent.isFile()) {
      results.push(path.relative(base, abs));
    }
  }
  return results;
}
