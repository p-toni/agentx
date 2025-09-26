export interface ProxyRule {
  readonly host: string;
  readonly methods: readonly string[];
}

export class AllowlistProxy {
  constructor(private readonly rules: readonly ProxyRule[]) {}

  isAllowed(url: URL, method: string): boolean {
    const hostRule = this.rules.find((rule) => rule.host === url.host);
    if (!hostRule) {
      return false;
    }

    return hostRule.methods.includes(method.toUpperCase());
  }
}
