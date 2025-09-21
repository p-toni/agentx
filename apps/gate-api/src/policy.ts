import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import type { LoadedIntent, NetworkEntrySummary } from './bundle';
import { URL } from 'node:url';

export interface PolicyConfig {
  readonly version: string;
  readonly allow?: AllowRule[];
  readonly caps?: {
    readonly maxAmount?: number;
  };
  readonly requireApprovalLabels?: string[];
}

export interface AllowRule {
  readonly domain: string;
  readonly methods?: string[];
  readonly paths?: string[];
}

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly policyVersion: string;
  readonly network: NetworkEvaluationResult[];
}

export interface NetworkEvaluationResult {
  readonly url: string;
  readonly method: string;
  readonly allowed: boolean;
}

export async function loadPolicy(policyPath: string): Promise<PolicyConfig> {
  const raw = await readFile(policyPath, 'utf8');
  const data = YAML.parse(raw) as PolicyConfig;
  if (!data?.version) {
    throw new Error('policy version is required');
  }
  return data;
}

export function evaluatePolicy(
  policy: PolicyConfig,
  intents: LoadedIntent[],
  networkEntries: NetworkEntrySummary[]
): PolicyEvaluation {
  const reasons: string[] = [];
  const network = evaluateNetwork(policy.allow ?? [], networkEntries, reasons);
  const requiresApproval = checkApproval(policy, intents, reasons);
  const allowed = reasons.length === 0;
  return {
    allowed,
    requiresApproval,
    reasons,
    policyVersion: policy.version,
    network
  };
}

function evaluateNetwork(rules: AllowRule[], entries: NetworkEntrySummary[], reasons: string[]): NetworkEvaluationResult[] {
  return entries.map((entry) => {
    const allowed = rules.length === 0 || rules.some((rule) => matchesRule(rule, entry));
    if (!allowed) {
      reasons.push(`network request to ${entry.url} is not allowed by policy`);
    }
    return { ...entry, allowed };
  });
}

function matchesRule(rule: AllowRule, entry: NetworkEntrySummary): boolean {
  try {
    const url = new URL(entry.url);
    if (url.hostname !== rule.domain) {
      return false;
    }
    const methods = rule.methods?.map((m) => m.toUpperCase());
    if (methods && !methods.includes(entry.method.toUpperCase())) {
      return false;
    }
    if (!rule.paths || rule.paths.length === 0) {
      return true;
    }
    return rule.paths.some((pattern) => matchesPath(pattern, url.pathname));
  } catch {
    return false;
  }
}

function matchesPath(pattern: string, path: string): boolean {
  if (pattern === '*' || pattern === '/*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

function checkApproval(policy: PolicyConfig, intents: LoadedIntent[], reasons: string[]): boolean {
  let requiresApproval = false;
  const labels = new Set(policy.requireApprovalLabels ?? []);
  for (const intent of intents) {
    const payload = intent.payload as Record<string, unknown> | undefined;
    if (payload) {
      const amount = payload.amount;
      if (typeof amount === 'number' && policy.caps?.maxAmount !== undefined && amount > policy.caps.maxAmount) {
        reasons.push(`intent ${intent.type} exceeds maxAmount cap ${policy.caps.maxAmount}`);
      }
      const payloadLabels = extractLabels(payload);
      if (payloadLabels.some((label) => labels.has(label))) {
        requiresApproval = true;
      }
    }
  }
  return requiresApproval;
}

function extractLabels(payload: Record<string, unknown>): string[] {
  const labels = payload.labels;
  if (Array.isArray(labels)) {
    return labels.filter((label): label is string => typeof label === 'string');
  }
  return [];
}
