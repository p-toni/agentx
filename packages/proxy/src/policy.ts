import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';

export interface PolicyRule {
  readonly host: string;
  readonly methods: readonly string[];
  readonly pathPrefixes?: readonly string[];
}

export interface PolicyCheck {
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
}

export class AllowPolicy {
  private readonly rules: readonly NormalisedRule[];

  constructor(rules: readonly PolicyRule[]) {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error('AllowPolicy requires at least one rule');
    }

    this.rules = rules.map(normaliseRule);
  }

  isAllowed(check: PolicyCheck): boolean {
    const hostWithPort = `${check.host}:${check.port}`.toLowerCase();
    const method = check.method.toUpperCase();
    const path = check.path.startsWith('/') ? check.path : `/${check.path}`;

    return this.rules.some((rule) => {
      if (rule.host !== hostWithPort && rule.host !== check.host.toLowerCase()) {
        return false;
      }

      if (!rule.methods.has(method) && !rule.methods.has('*')) {
        return false;
      }

      if (rule.pathPrefixes.length === 0) {
        return true;
      }

      return rule.pathPrefixes.some((prefix) => path.startsWith(prefix));
    });
  }
}

interface PolicyFile {
  readonly rules: PolicyRule[];
}

interface NormalisedRule {
  readonly host: string;
  readonly methods: Set<string>;
  readonly pathPrefixes: readonly string[];
}

function normaliseRule(rule: PolicyRule): NormalisedRule {
  if (!rule.host) {
    throw new Error('policy rule requires a host');
  }

  const host = rule.host.toLowerCase();
  const methods = (rule.methods ?? ['*']).map((method) => method.toUpperCase());
  const pathPrefixes = (rule.pathPrefixes ?? []).map((prefix) => (prefix.startsWith('/') ? prefix : `/${prefix}`));

  return {
    host,
    methods: new Set(methods.length > 0 ? methods : ['*']),
    pathPrefixes
  };
}

export async function loadPolicy(filePath: string): Promise<AllowPolicy> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = YAML.parse(raw) as PolicyFile | undefined;
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error(`Invalid policy file at ${filePath}`);
  }

  return new AllowPolicy(parsed.rules);
}

export async function savePolicyTemplate(filePath: string, template: PolicyFile): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.stringify(template), 'utf8');
}
