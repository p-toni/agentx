import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import traceBundleSchema from './trace-bundle.schema.json';

export const TRACE_BUNDLE_VERSION = 'deterministic-agent-lab/trace-bundle@1';
export const TRACE_BUNDLE_SCHEMA = traceBundleSchema;

const COMPONENT_ORDER = [
  'env',
  'clock',
  'network',
  'fsDiff',
  'logs',
  'prompts',
  'intents'
] as const;

type BundleComponent = (typeof COMPONENT_ORDER)[number];

export interface TraceBundleManifest {
  version: typeof TRACE_BUNDLE_VERSION;
  createdAt: string;
  description?: string;
  metadata?: Record<string, unknown>;
  files: Record<BundleComponent, string>;
  hashes?: Partial<Record<BundleComponent, string>>;
}

export interface TraceBundle {
  root: string;
  manifest: TraceBundleManifest;
}

export interface IntentRecord {
  timestamp: string;
  intent: string;
  payload?: unknown;
  [key: string]: unknown;
}

export interface CreateBundleInput {
  createdAt?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  env?: Record<string, unknown>;
  clock?: Record<string, unknown>;
  network?: string | Record<string, unknown>;
  fsDiff?: Record<string, string | Buffer>;
  logs?: Record<string, string | Buffer>;
  prompts?: Record<string, string | Buffer>;
  intents?: (string | IntentRecord)[];
}

const DEFAULT_FILES: Record<BundleComponent, string> = {
  env: 'env.json',
  clock: 'clock.json',
  network: 'network.har',
  fsDiff: 'fs-diff',
  logs: 'logs',
  prompts: 'prompts',
  intents: 'intents.jsonl'
};

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  allowUnionTypes: true
});

addFormats(ajv);

const validateManifest = ajv.compile<TraceBundleManifest>(traceBundleSchema);

export class TraceBundleValidationError extends Error {
  constructor(message: string, readonly details?: ErrorObject[]) {
    super(message);
    this.name = 'TraceBundleValidationError';
  }
}

export async function createBundle(dir: string, input: CreateBundleInput = {}): Promise<TraceBundle> {
  const root = resolve(dir);
  await fs.mkdir(root, { recursive: true });

  const envPath = join(root, DEFAULT_FILES.env);
  const clockPath = join(root, DEFAULT_FILES.clock);
  const networkPath = join(root, DEFAULT_FILES.network);
  const fsDiffPath = join(root, DEFAULT_FILES.fsDiff);
  const logsPath = join(root, DEFAULT_FILES.logs);
  const promptsPath = join(root, DEFAULT_FILES.prompts);
  const intentsPath = join(root, DEFAULT_FILES.intents);

  await writeJsonFile(envPath, input.env ?? { seed: null, variables: {} });
  await writeJsonFile(clockPath, input.clock ?? { initialTime: new Date(0).toISOString(), ticks: [] });
  await writeNetworkFile(networkPath, input.network);
  await writeDirectory(fsDiffPath, input.fsDiff);
  await writeDirectory(logsPath, input.logs);
  await writeDirectory(promptsPath, input.prompts);
  await writeIntentsFile(intentsPath, input.intents);

  const files: Record<BundleComponent, string> = {
    env: DEFAULT_FILES.env,
    clock: DEFAULT_FILES.clock,
    network: DEFAULT_FILES.network,
    fsDiff: ensureTrailingSlash(DEFAULT_FILES.fsDiff),
    logs: ensureTrailingSlash(DEFAULT_FILES.logs),
    prompts: ensureTrailingSlash(DEFAULT_FILES.prompts),
    intents: DEFAULT_FILES.intents
  };

  const hashes = await computeComponentHashes(root, files);

  const manifest: TraceBundleManifest = {
    version: TRACE_BUNDLE_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    description: input.description,
    metadata: input.metadata,
    files,
    hashes
  };

  const manifestPath = join(root, 'manifest.json');
  await writeJsonFile(manifestPath, manifest);

  return openBundle(root);
}

export async function openBundle(path: string): Promise<TraceBundle> {
  const root = resolve(path);
  const manifestPath = join(root, 'manifest.json');

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new TraceBundleValidationError(`Missing manifest.json at ${manifestPath}`);
  }

  let manifest: TraceBundleManifest;
  try {
    manifest = JSON.parse(manifestRaw) as TraceBundleManifest;
  } catch (error) {
    throw new TraceBundleValidationError('Manifest is not valid JSON');
  }

  const bundle: TraceBundle = { root, manifest };
  await validateBundle(bundle);
  return bundle;
}

export async function validateBundle(bundle: TraceBundle): Promise<void> {
  if (!validateManifest(bundle.manifest)) {
    throw new TraceBundleValidationError('Manifest validation failed', validateManifest.errors ?? undefined);
  }

  for (const component of COMPONENT_ORDER) {
    const relativePath = bundle.manifest.files[component];
    const fullPath = join(bundle.root, relativePath.replace(/\/$/, ''));
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch (error) {
      throw new TraceBundleValidationError(`Missing ${component} entry at ${relativePath}`);
    }

    const shouldBeDirectory = component === 'fsDiff' || component === 'logs' || component === 'prompts';
    if (shouldBeDirectory && !stats.isDirectory()) {
      throw new TraceBundleValidationError(`Expected directory for ${component} at ${relativePath}`);
    }

    if (!shouldBeDirectory && !stats.isFile()) {
      throw new TraceBundleValidationError(`Expected file for ${component} at ${relativePath}`);
    }
  }

  if (!bundle.manifest.hashes) {
    return;
  }

  for (const [component, expectedHash] of Object.entries(bundle.manifest.hashes) as [BundleComponent, string][]) {
    const relativePath = bundle.manifest.files[component];
    const fullPath = join(bundle.root, relativePath.replace(/\/$/, ''));
    const actualHash = await hashPath(fullPath);
    if (actualHash !== expectedHash) {
      throw new TraceBundleValidationError(
        `Checksum mismatch for ${component}: expected ${expectedHash} but got ${actualHash}`
      );
    }
  }
}

export async function hashBundle(bundle: TraceBundle): Promise<string> {
  await validateBundle(bundle);
  const hash = createHash('sha256');
  hash.update(canonicalStringify(bundle.manifest));

  for (const component of COMPONENT_ORDER) {
    const relativePath = bundle.manifest.files[component];
    const fullPath = join(bundle.root, relativePath.replace(/\/$/, ''));
    const componentHash = await hashPath(fullPath);
    hash.update(`${component}:${componentHash}\n`);
  }

  return hash.digest('hex');
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => a.localeCompare(b));
    const result: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      result[key] = sortValue(val);
    }
    return result;
  }

  return value;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(data ?? {}, null, 2) + '\n';
  await fs.writeFile(path, payload, 'utf8');
}

async function writeNetworkFile(path: string, network?: string | Record<string, unknown>): Promise<void> {
  const defaultHar = {
    log: {
      version: '1.2',
      creator: { name: 'trace-bundle', version: '1.0.0' },
      pages: [],
      entries: [],
      comment: 'Generated by deterministic-agent-lab'
    }
  };

  let payload: string;
  if (!network) {
    payload = JSON.stringify(defaultHar, null, 2);
  } else if (typeof network === 'string') {
    payload = network;
  } else {
    payload = JSON.stringify(network, null, 2);
  }

  if (!payload.endsWith('\n')) {
    payload += '\n';
  }

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, payload, 'utf8');
}

async function writeDirectory(root: string, entries?: Record<string, string | Buffer>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  if (!entries) {
    return;
  }

  const sortedEntries = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  for (const [relativePath, content] of sortedEntries) {
    const fullPath = join(root, relativePath);
    await fs.mkdir(dirname(fullPath), { recursive: true });
    const data: string | Uint8Array = typeof content === 'string' ? content : new Uint8Array(content);
    await fs.writeFile(fullPath, data);
  }
}

async function writeIntentsFile(path: string, intents?: (string | IntentRecord)[]): Promise<void> {
  const lines = (intents ?? []).map((entry) =>
    typeof entry === 'string' ? entry : JSON.stringify(entry)
  );
  const payload = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, payload, 'utf8');
}

async function computeComponentHashes(root: string, files: Record<BundleComponent, string>): Promise<Record<BundleComponent, string>> {
  const hashes = {} as Partial<Record<BundleComponent, string>>;
  for (const component of COMPONENT_ORDER) {
    const target = join(root, files[component].replace(/\/$/, ''));
    hashes[component] = await hashPath(target);
  }
  return hashes as Record<BundleComponent, string>;
}

async function hashPath(path: string): Promise<string> {
  const stats = await fs.stat(path);
  if (stats.isFile()) {
    return hashFile(path);
  }

  if (stats.isDirectory()) {
    return hashDirectory(path);
  }

  throw new TraceBundleValidationError(`Unsupported bundle entry type at ${path}`);
}

async function hashFile(path: string): Promise<string> {
  const data = new Uint8Array(await fs.readFile(path));
  return createHash('sha256').update(data).digest('hex');
}

async function hashDirectory(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash('sha256');
  hash.update('dir\n');
  for (const relativePath of files) {
    const fullPath = join(root, relativePath);
    const fileHash = await hashFile(fullPath);
    hash.update(`${relativePath}\n${fileHash}\n`);
  }
  return hash.digest('hex');
}

async function listFiles(root: string, current = ''): Promise<string[]> {
  const directory = current ? join(root, current) : root;
  const dirents = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const dirent of dirents) {
    const nextRelative = current ? join(current, dirent.name) : dirent.name;
    if (dirent.isDirectory()) {
      files.push(...(await listFiles(root, nextRelative)));
    } else if (dirent.isFile()) {
      files.push(nextRelative.split('\\').join('/'));
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

// Utility primarily for tests to create deterministic temporary directories.
export async function createTemporaryBundleDirectory(prefix = 'trace-bundle-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}
