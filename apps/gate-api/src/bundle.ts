import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
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
  readonly networkHar?: string | null;
  readonly prompts: PromptRecord[];
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
  readonly changed: FileDiffEntry[];
  readonly deleted: FileDiffEntry[];
}

export interface FileDiffEntry {
  readonly path: string;
  readonly before?: FileVersion;
  readonly after?: FileVersion;
}

export interface FileVersion {
  readonly isBinary: boolean;
  readonly text?: string;
}

export interface PromptRecord {
  readonly name: string;
  readonly content: string;
}

export async function loadPlanSummary(bundlePath: string): Promise<PlanSummary> {
  const extraction = await extractBundle(bundlePath);
  try {
    const bundle = await openBundle(extraction.root);
    const intents = await loadBundleIntents(bundle, extraction.root);
    const fsDiff = await readFsDiff(bundle, extraction.root);
    const { entries: network, har } = await readNetworkEntries(bundle, extraction.root);
    const prompts = await readPrompts(bundle, extraction.root);
    return { bundle, intents, fsDiff, network, networkHar: har, prompts };
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

  const changedFiles = await listFiles(changedDir, changedDir);

  const baseDir = await mkdtemp(path.join(tmpdir(), 'gate-base-'));
  const baseTar = path.join(fsDiffRoot, 'base.tar');
  const hasBaseTar = await exists(baseTar);
  if (hasBaseTar) {
    await extractTar(baseTar, baseDir);
  }

  const changedEntries: FileDiffEntry[] = [];
  for (const relativePath of changedFiles.sort()) {
    const afterPath = path.join(changedDir, relativePath);
    const beforePath = path.join(baseDir, relativePath);
    const afterVersion = await readVersion(afterPath);
    const beforeVersion = hasBaseTar ? await readVersion(beforePath).catch(() => undefined) : undefined;
    changedEntries.push({
      path: relativePath,
      before: beforeVersion,
      after: afterVersion
    });
  }

  let deletedPaths: string[] = [];
  try {
    const raw = await readFile(deletedFile, 'utf8');
    deletedPaths = JSON.parse(raw) as string[];
  } catch {
    deletedPaths = [];
  }

  const deletedEntries: FileDiffEntry[] = [];
  for (const relativePath of deletedPaths.sort()) {
    const beforePath = path.join(baseDir, relativePath);
    const beforeVersion = hasBaseTar ? await readVersion(beforePath).catch(() => undefined) : undefined;
    deletedEntries.push({
      path: relativePath,
      before: beforeVersion,
      after: undefined
    });
  }

  await rm(baseDir, { recursive: true, force: true });

  return {
    changed: changedEntries,
    deleted: deletedEntries
  };
}

async function readNetworkEntries(bundle: TraceBundle, root: string): Promise<{ entries: NetworkEntrySummary[]; har: string | null }> {
  const networkPath = path.join(root, bundle.manifest.files.network);
  try {
    const raw = await readFile(networkPath, 'utf8');
    const har = JSON.parse(raw) as { log?: { entries?: Array<{ request?: { method?: string; url?: string; headers?: Array<{ name: string; value: string }> } }> } };
    const entries = har.log?.entries ?? [];
    const mapped = entries
      .map((entry) => {
        const method = (entry.request?.method ?? 'GET').toUpperCase();
        const url = entry.request?.url ?? '';
        const headers = Object.fromEntries((entry.request?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
        return { url, method, headers };
      })
      .filter((entry) => entry.url.length > 0);
    return { entries: mapped, har: raw };
  } catch {
    return { entries: [], har: null };
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

async function extractTar(tarFile: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', tarFile, '-C', destination]);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code ?? 0}`));
      }
    });
  });
}

async function readVersion(filePath: string): Promise<FileVersion> {
  try {
    const data = await readFile(filePath);
    const isBinary = isBinaryBuffer(data);
    return {
      isBinary,
      text: isBinary ? undefined : data.toString('utf8')
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        isBinary: false,
        text: undefined
      };
    }
    throw error;
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 1000);
  for (let i = 0; i < len; i += 1) {
    const charCode = buffer[i];
    if (charCode === 0) {
      return true;
    }
  }
  return false;
}

async function readPrompts(bundle: TraceBundle, root: string): Promise<PromptRecord[]> {
  const promptsRoot = path.join(root, bundle.manifest.files.prompts.replace(/\/$/, ''));
  const records: PromptRecord[] = [];
  try {
    const files = await listFiles(promptsRoot, promptsRoot);
    for (const file of files) {
      const full = path.join(promptsRoot, file);
      const content = await readFile(full, 'utf8');
      records.push({ name: file, content });
    }
  } catch {
    // ignore
  }
  return records;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
