export interface ProxyEnvironmentOptions {
  readonly proxyUrl: string;
  readonly caCertPath?: string;
  readonly noProxy?: string;
}

export interface ProxyEnvironmentHandle {
  restore(): void;
}

export function configureProxyEnvironment(options: ProxyEnvironmentOptions): ProxyEnvironmentHandle {
  const previous = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
    CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE,
    NO_PROXY: process.env.NO_PROXY
  };

  process.env.HTTP_PROXY = options.proxyUrl;
  process.env.HTTPS_PROXY = options.proxyUrl;
  process.env.ALL_PROXY = options.proxyUrl;
  process.env.NO_PROXY = options.noProxy ?? '127.0.0.1,localhost';

  if (options.caCertPath) {
    process.env.NODE_EXTRA_CA_CERTS = options.caCertPath;
    process.env.REQUESTS_CA_BUNDLE = options.caCertPath;
    process.env.CURL_CA_BUNDLE = options.caCertPath;
  }

  return {
    restore() {
      restoreEnv(previous);
    }
  };
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
