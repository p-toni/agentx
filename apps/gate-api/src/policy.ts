import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadPolicy as loadWasmPolicy, type LoadedPolicy } from '@open-policy-agent/opa-wasm';
import type { LoadedIntent, NetworkEntrySummary } from './bundle';

export interface PolicyBundleDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
}

export interface PolicyIntentDecision {
  readonly index: number;
  readonly type: string;
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly approvalReasons: string[];
}

export interface PolicyNetworkDecision {
  readonly url: string;
  readonly method: string;
  readonly allowed: boolean;
  readonly reasons: string[];
}

export interface PolicyEvaluation {
  readonly policyVersion: string;
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly bundle: PolicyBundleDecision;
  readonly intents: PolicyIntentDecision[];
  readonly network: PolicyNetworkDecision[];
}

export type PolicyStage = 'plan' | 'commit';

export interface PolicyEvaluationContext {
  readonly stage: PolicyStage;
  readonly now: Date;
}

export interface PolicyEngine {
  readonly version: string;
  evaluate(
    context: PolicyEvaluationContext,
    intents: LoadedIntent[],
    network: NetworkEntrySummary[]
  ): PolicyEvaluation;
}

interface PolicyData {
  readonly config: {
    readonly version: string;
    readonly allow?: Array<{
      readonly domains?: string[];
      readonly methods?: string[];
      readonly paths?: string[];
    }>;
    readonly caps?: {
      readonly maxAmount?: number | null;
    } | null;
    readonly requireApprovalLabels?: string[] | null;
    readonly timeWindow?: {
      readonly start?: string | null;
      readonly end?: string | null;
      readonly timezone?: string | null;
      readonly startMinutes?: number | null;
      readonly endMinutes?: number | null;
    } | null;
  };
}

interface AugmentedPolicyData extends PolicyData {
  readonly config: PolicyData['config'] & {
    readonly timeWindow?: PolicyData['config']['timeWindow'] & {
      readonly startMinutes?: number | null;
      readonly endMinutes?: number | null;
    } | null;
  };
}

interface GateDecision {
  readonly policyVersion: string;
  readonly bundle: PolicyBundleDecision;
  readonly intents: PolicyIntentDecision[];
  readonly network: PolicyNetworkDecision[];
}

class WasmPolicyEngine implements PolicyEngine {
  private readonly policy: LoadedPolicy;
  private readonly data: AugmentedPolicyData;

  constructor(policy: LoadedPolicy, data: AugmentedPolicyData) {
    this.policy = policy;
    this.data = data;
  }

  get version(): string {
    return this.data.config.version;
  }

  evaluate(
    context: PolicyEvaluationContext,
    intents: LoadedIntent[],
    network: NetworkEntrySummary[]
  ): PolicyEvaluation {
    const input = {
      context: buildContextPayload(context, this.data.config.timeWindow ?? undefined),
      intents: intents.map(normaliseIntentForPolicy),
      network: network.map(normaliseNetworkForPolicy)
    };

    const results = this.policy.evaluate(input);
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error('policy evaluation returned no result');
    }
    const decision = results[0]?.result as GateDecision | undefined;
    if (!decision) {
      throw new Error('policy evaluation missing decision payload');
    }

    const { bundle, intents: intentDecisions, network: networkDecisions, policyVersion } = decision;
    const bundleDecision: PolicyBundleDecision = {
      allowed: bundle?.allowed ?? false,
      requiresApproval: bundle?.requiresApproval ?? false,
      reasons: bundle?.reasons ?? []
    };

    return {
      policyVersion,
      allowed: bundleDecision.allowed,
      requiresApproval: bundleDecision.requiresApproval,
      reasons: bundleDecision.reasons,
      bundle: bundleDecision,
      intents: Array.isArray(intentDecisions) ? intentDecisions : [],
      network: Array.isArray(networkDecisions) ? networkDecisions : []
    } satisfies PolicyEvaluation;
  }
}

export async function loadPolicy(policyPath: string): Promise<PolicyEngine> {
  const { wasmPath, dataPath } = resolvePolicyArtifacts(policyPath);
  const [wasmSource, dataSource] = await Promise.all([
    readFile(wasmPath),
    readFile(dataPath, 'utf8')
  ]);

  const data = JSON.parse(dataSource) as PolicyData;
  if (!data?.config?.version) {
    throw new Error('policy data must include config.version');
  }
  const augmented = augmentPolicyData(data);

  const policy = await loadWasmPolicy(wasmSource);
  await policy.setData(augmented);

  return new WasmPolicyEngine(policy, augmented);
}

function resolvePolicyArtifacts(policyPath: string): { wasmPath: string; dataPath: string } {
  const stats = path.extname(policyPath).toLowerCase();
  if (stats === '.wasm') {
    return {
      wasmPath: policyPath,
      dataPath: path.join(path.dirname(policyPath), 'data.json')
    };
  }
  if (stats === '.json') {
    return {
      wasmPath: path.join(path.dirname(policyPath), 'policy.wasm'),
      dataPath: policyPath
    };
  }
  return {
    wasmPath: path.join(policyPath, 'policy.wasm'),
    dataPath: path.join(policyPath, 'data.json')
  };
}

function augmentPolicyData(data: PolicyData): AugmentedPolicyData {
  const timeWindow = data.config.timeWindow;
  if (!timeWindow || !timeWindow.start || !timeWindow.end) {
    return data;
  }
  const startMinutes = parseTimeToMinutes(timeWindow.start);
  const endMinutes = parseTimeToMinutes(timeWindow.end);
  const withMinutes: AugmentedPolicyData = {
    ...data,
    config: {
      ...data.config,
      timeWindow: {
        ...timeWindow,
        startMinutes,
        endMinutes
      }
    }
  };
  return withMinutes;
}

function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^([0-9]{2}):([0-9]{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return hours * 60 + minutes;
}

function buildContextPayload(
  context: PolicyEvaluationContext,
  timeWindow: AugmentedPolicyData['config']['timeWindow']
): { readonly stage: PolicyStage; readonly currentMinutes?: number } {
  const payload: { stage: PolicyStage; currentMinutes?: number } = {
    stage: context.stage
  };

  const targetTimeWindow = timeWindow ?? undefined;
  if (targetTimeWindow?.startMinutes != null && targetTimeWindow.endMinutes != null) {
    const tz = targetTimeWindow.timezone ?? 'UTC';
    const minutes = extractLocalMinutes(context.now, tz);
    if (minutes != null) {
      payload.currentMinutes = minutes;
    }
  }

  return payload;
}

function extractLocalMinutes(date: Date, timeZone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((part) => part.type === 'hour');
    const minutePart = parts.find((part) => part.type === 'minute');
    if (!hourPart || !minutePart) {
      return null;
    }
    const hours = Number.parseInt(hourPart.value, 10);
    const minutes = Number.parseInt(minutePart.value, 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }
    return hours * 60 + minutes;
  } catch {
    return null;
  }
}

function normaliseIntentForPolicy(intent: LoadedIntent): Record<string, unknown> {
  const payload = intent.payload ?? null;
  const base: Record<string, unknown> = {
    index: intent.index,
    type: intent.type
  };
  if (payload !== null && payload !== undefined) {
    base.payload = payload;
  }
  if (intent.metadata !== undefined && intent.metadata !== null) {
    base.metadata = intent.metadata;
  }
  return base;
}

function normaliseNetworkForPolicy(entry: NetworkEntrySummary): Record<string, unknown> {
  const method = entry.method ?? '';
  const url = entry.url ?? '';
  const prepared: Record<string, unknown> = {
    url,
    method
  };
  try {
    const parsed = new URL(url);
    prepared.host = parsed.hostname.toLowerCase();
    prepared.path = parsed.pathname;
  } catch {
    prepared.host = '';
    prepared.path = '';
  }
  return prepared;
}
