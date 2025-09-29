import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSONPath } from 'jsonpath-plus';
import { parse as parseYaml } from 'yaml';

export interface HttpRollbackRegistryConfig {
  readonly rules?: HttpRollbackRuleConfig[];
}

export interface HttpRollbackRuleConfig {
  readonly name: string;
  readonly host: string;
  readonly commit: {
    readonly method?: string;
    readonly path: string;
    readonly idFrom?: string[];
  };
  readonly rollback: {
    readonly method: 'DELETE' | 'POST';
    readonly pathTemplate: string;
    readonly headers?: Record<string, string>;
  };
  readonly matchers?: {
    readonly headers?: Record<string, string>;
    readonly json?: HttpRollbackJsonMatcher[];
  };
}

export interface HttpRollbackJsonMatcher {
  readonly path: string;
  readonly equals?: unknown;
  readonly exists?: boolean;
}

export interface HttpRollbackRequestContext {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly bodyText?: string;
  readonly bodyJson?: unknown;
}

export interface HttpRollbackResolveOptions {
  readonly baseUrl: string;
  readonly responseHeaders: Record<string, string | undefined>;
  readonly responseBodyText: string;
}

export interface ResolvedHttpRollback {
  readonly ruleName: string;
  readonly method: 'DELETE' | 'POST';
  readonly pathTemplate: string;
  readonly path: string;
  readonly url: string;
  readonly id?: string;
  readonly headers?: Record<string, string>;
}

export interface HttpRollbackRuleMatch {
  readonly name: string;
  readonly method: 'DELETE' | 'POST';
  readonly pathTemplate: string;
  readonly headers?: Record<string, string>;
  readonly requiresId: boolean;
  readonly idSources: string[];
  resolve(options: HttpRollbackResolveOptions): ResolvedHttpRollback | null;
}

export interface HttpRollbackRegistry {
  findRule(context: HttpRollbackRequestContext): HttpRollbackRuleMatch | null;
}

export function createHttpRollbackRegistry(
  config: HttpRollbackRegistryConfig | null | undefined
): HttpRollbackRegistry {
  const compiledRules = compileRegistry(config);
  if (compiledRules.length === 0) {
    return emptyRegistry;
  }
  return new CompiledHttpRollbackRegistry(compiledRules);
}

export function loadHttpRollbackRegistrySync(filePath: string): HttpRollbackRegistry {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseRegistrySource(filePath, raw);
    return createHttpRollbackRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry;
    }
    throw error;
  }
}

export function tryLoadHttpRollbackRegistrySync(filePath: string): HttpRollbackRegistry | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseRegistrySource(filePath, raw);
    return createHttpRollbackRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

const emptyRegistry: HttpRollbackRegistry = {
  findRule(): HttpRollbackRuleMatch | null {
    return null;
  }
};

interface CompiledHttpRollbackRule {
  readonly name: string;
  readonly hostPattern: RegExp;
  readonly method: string;
  readonly pathPattern: RegExp;
  readonly idSources: IdSource[];
  readonly rollback: {
    readonly method: 'DELETE' | 'POST';
    readonly pathTemplate: string;
    readonly headers?: Record<string, string>;
    readonly requiresId: boolean;
  };
  readonly matchers: {
    readonly headers: Array<{ key: string; value: string }>;
    readonly json: CompiledJsonMatcher[];
  };
}

interface IdSource {
  readonly kind: 'header' | 'json';
  readonly locator: string;
  readonly original: string;
}

interface CompiledJsonMatcher {
  readonly path: string;
  readonly equals?: unknown;
  readonly exists: boolean;
}

class CompiledHttpRollbackRegistry implements HttpRollbackRegistry {
  constructor(private readonly rules: CompiledHttpRollbackRule[]) {}

  findRule(context: HttpRollbackRequestContext): HttpRollbackRuleMatch | null {
    let bodyJson = context.bodyJson;
    for (const rule of this.rules) {
      if (!this.matchesRule(rule, context, bodyJson)) {
        continue;
      }

      const match: HttpRollbackRuleMatch = {
        name: rule.name,
        method: rule.rollback.method,
        pathTemplate: rule.rollback.pathTemplate,
        headers: rule.rollback.headers,
        requiresId: rule.rollback.requiresId,
        idSources: rule.idSources.map((source) => source.original),
        resolve: (options) => resolveRollback(rule, options)
      };
      return match;
    }

    return null;
  }

  private matchesRule(
    rule: CompiledHttpRollbackRule,
    context: HttpRollbackRequestContext,
    bodyJson: unknown
  ): boolean {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(context.url);
    } catch {
      return false;
    }

    if (!rule.hostPattern.test(parsedUrl.hostname.toLowerCase())) {
      return false;
    }

    if (rule.method !== context.method.toUpperCase()) {
      return false;
    }

    if (!rule.pathPattern.test(parsedUrl.pathname)) {
      return false;
    }

    const headers = lowerCaseHeaderMap(context.headers);
    for (const matcher of rule.matchers.headers) {
      if (headers.get(matcher.key) !== matcher.value) {
        return false;
      }
    }

    if (rule.matchers.json.length > 0) {
      if (bodyJson === undefined && context.bodyText) {
        try {
          bodyJson = JSON.parse(context.bodyText);
        } catch {
          bodyJson = undefined;
        }
      }

    for (const matcher of rule.matchers.json) {
      const jsonSource = bodyJson ?? null;
      const results = (JSONPath({ path: matcher.path, json: jsonSource }) as unknown[]).filter(
        (value) => value !== undefined
      );
      if (matcher.exists && results.length === 0) {
        return false;
      }
        if ('equals' in matcher) {
          const hasEqual = results.some((value) => deepEqual(value, matcher.equals));
          if (!hasEqual) {
            return false;
          }
        }
      }
    }

    return true;
  }
}

function resolveRollback(
  rule: CompiledHttpRollbackRule,
  options: HttpRollbackResolveOptions
): ResolvedHttpRollback | null {
  const headers = lowerCaseHeaderMap(options.responseHeaders);
  const requiresId = rule.rollback.requiresId;
  let resolvedId: string | undefined;

  if (rule.idSources.length > 0) {
    const responseBodyText = options.responseBodyText;
    let responseJson: unknown | undefined;

    for (const source of rule.idSources) {
      if (source.kind === 'header') {
        const headerValue = headers.get(source.locator);
        if (headerValue) {
          resolvedId = headerValue.trim();
        }
      } else if (source.kind === 'json') {
        if (responseJson === undefined) {
          try {
            responseJson = JSON.parse(responseBodyText);
          } catch {
            responseJson = null;
          }
        }
        const jsonSource = responseJson ?? null;
        const results = (JSONPath({ path: source.locator, json: jsonSource }) as unknown[]).filter(
          (value) => value !== undefined
        );
        const match = results.find((value) => isScalar(value));
        if (typeof match === 'string' || typeof match === 'number' || typeof match === 'boolean') {
          resolvedId = String(match);
        }
      }

      if (resolvedId) {
        break;
      }
    }
  }

  if (requiresId && (!resolvedId || resolvedId.length === 0)) {
    return null;
  }

  const substitutions: Record<string, string | undefined> = {
    id: resolvedId
  };

  const resolvedPath = substituteTemplate(rule.rollback.pathTemplate, substitutions);
  if (!resolvedPath) {
    return null;
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    return null;
  }

  let target: URL;
  try {
    target = new URL(resolvedPath, baseUrl);
  } catch {
    return null;
  }

  return {
    ruleName: rule.name,
    method: rule.rollback.method,
    pathTemplate: rule.rollback.pathTemplate,
    path: resolvedPath,
    url: target.toString(),
    id: resolvedId,
    headers: rule.rollback.headers
  } satisfies ResolvedHttpRollback;
}

function compileRegistry(config: HttpRollbackRegistryConfig | null | undefined): CompiledHttpRollbackRule[] {
  if (!config?.rules || config.rules.length === 0) {
    return [];
  }

  return config.rules.map((rule) => compileRule(rule));
}

function compileRule(rule: HttpRollbackRuleConfig): CompiledHttpRollbackRule {
  if (!rule.name || rule.name.trim().length === 0) {
    throw new Error('http rollback rule missing name');
  }
  if (!rule.host || rule.host.trim().length === 0) {
    throw new Error(`http rollback rule ${rule.name} is missing host`);
  }
  if (!rule.commit?.path) {
    throw new Error(`http rollback rule ${rule.name} is missing commit.path`);
  }

  const method = (rule.commit.method ?? 'POST').toUpperCase();
  const hostPattern = wildcardToRegExp(rule.host.trim().toLowerCase());
  const pathPattern = wildcardToRegExp(rule.commit.path.trim());
  const idSources = (rule.commit.idFrom ?? []).map(parseIdSource);
  const requiresId = rule.rollback.pathTemplate.includes('{');
  const headers = rule.rollback.headers ? { ...rule.rollback.headers } : undefined;

  const matcherHeaders = Object.entries(rule.matchers?.headers ?? {}).map(([key, value]) => ({
    key: key.toLowerCase(),
    value
  }));

  const matcherJson = (rule.matchers?.json ?? []).map((matcher) => ({
    path: matcher.path,
    equals: matcher.equals,
    exists: matcher.exists ?? true
  } satisfies CompiledJsonMatcher));

  return {
    name: rule.name,
    hostPattern,
    method,
    pathPattern,
    idSources,
    rollback: {
      method: rule.rollback.method,
      pathTemplate: rule.rollback.pathTemplate,
      headers,
      requiresId
    },
    matchers: {
      headers: matcherHeaders,
      json: matcherJson
    }
  } satisfies CompiledHttpRollbackRule;
}

function parseIdSource(value: string): IdSource {
  const trimmed = value.trim();
  const [rawKind, locator] = splitKindLocator(trimmed);
  if (rawKind === 'header') {
    return {
      kind: 'header',
      locator: locator.toLowerCase(),
      original: trimmed
    } satisfies IdSource;
  }
  if (rawKind === 'json') {
    return {
      kind: 'json',
      locator,
      original: trimmed
    } satisfies IdSource;
  }
  throw new Error(`unsupported idFrom entry: ${value}`);
}

function splitKindLocator(value: string): [string, string] {
  const index = value.indexOf(':');
  if (index === -1 || index === value.length - 1) {
    throw new Error(`idFrom entry must be in the form kind:locator (received: ${value})`);
  }
  const kind = value.slice(0, index).trim().toLowerCase();
  const locator = value.slice(index + 1).trim();
  if (!locator) {
    throw new Error(`idFrom entry missing locator segment (${value})`);
  }
  return [kind, locator];
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSource = `^${escaped.replace(/\*/g, '.*')}$`;
  return new RegExp(regexSource);
}

function substituteTemplate(template: string, values: Record<string, string | undefined>): string | null {
  let missing = false;
  const result = template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      missing = true;
      return '';
    }
    return String(value);
  });

  if (missing) {
    return null;
  }

  return result;
}

type HeaderCollection =
  | Record<string, string | undefined>
  | Map<string, string>
  | { forEach?: (callback: (value: string, key: string) => void) => void };

function lowerCaseHeaderMap(headers: HeaderCollection | undefined): Map<string, string> {
  if (!headers) {
    return new Map();
  }
  if (headers instanceof Map) {
    return new Map(Array.from(headers.entries()).map(([key, value]) => [key.toLowerCase(), value]));
  }
  if (typeof headers.forEach === 'function') {
    const result = new Map<string, string>();
    headers.forEach((value, key) => {
      result.set(key.toLowerCase(), value);
    });
    return result;
  }
  return new Map(
    Object.entries(headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key.toLowerCase(), value])
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aEntries = Object.entries(a as Record<string, unknown>);
  const bEntries = Object.entries(b as Record<string, unknown>);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([key, value]) => deepEqual(value, (b as Record<string, unknown>)[key]));
}

function isScalar(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function parseRegistrySource(filePath: string, source: string): HttpRollbackRegistryConfig {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') {
    return (parseYaml(source) ?? {}) as HttpRollbackRegistryConfig;
  }
  if (extension === '.json') {
    return JSON.parse(source) as HttpRollbackRegistryConfig;
  }
  if (source.trim().startsWith('{') || source.trim().startsWith('[')) {
    return JSON.parse(source) as HttpRollbackRegistryConfig;
  }
  return (parseYaml(source) ?? {}) as HttpRollbackRegistryConfig;
}
