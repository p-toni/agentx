import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ProxyFactory, {
  type IContext,
  type IProxy,
  type ErrorCallback,
  type DataCallback
} from 'http-mitm-proxy';
import { AllowPolicy } from './policy';
import { HarRecorder, HarReplay, HarReplayMatch, harCreatorMeta, HarRecordInput } from './har';

type MitmContext = IContext;
type MitmProxy = IProxy;

export type ProxyMode = 'record' | 'replay' | 'passthrough';

export interface EgressProxyOptions {
  readonly mode: ProxyMode;
  readonly policy: AllowPolicy;
  readonly harPath: string;
  readonly caCertPath: string;
  readonly listenPort?: number;
  readonly listenHost?: string;
  readonly sslCacheDir?: string;
  readonly logger?: (message: string) => void;
}

export interface BlockedRequest {
  readonly url: string;
  readonly method: string;
  readonly reason: 'policy' | 'missing-recording';
}

export interface EgressProxyStartResult {
  readonly port: number;
  readonly host: string;
  readonly caCertPath: string;
}

export class EgressProxy {
  private readonly mode: ProxyMode;
  private readonly policy: AllowPolicy;
  private readonly harPath: string;
  private readonly caCertPath: string;
  private readonly listenHost: string;
  private readonly listenPort: number | undefined;
  private readonly sslCacheDir: string;
  private readonly logger: (message: string) => void;

  private readonly proxy: MitmProxy;
  private harRecorder?: HarRecorder;
  private harReplay?: HarReplay;
  private blocked: BlockedRequest[] = [];
  private started = false;

  constructor(options: EgressProxyOptions) {
    this.mode = options.mode;
    this.policy = options.policy;
    this.harPath = resolve(options.harPath);
    this.caCertPath = resolve(options.caCertPath);
    this.listenHost = options.listenHost ?? '127.0.0.1';
    this.listenPort = options.listenPort;
    this.sslCacheDir = options.sslCacheDir
      ? resolve(options.sslCacheDir)
      : resolve(dirname(this.caCertPath), '.proxy-ca-cache');
    this.logger = options.logger ?? ((message) => console.warn(`[proxy] ${message}`));
    this.proxy = ProxyFactory();
  }

  async start(): Promise<EgressProxyStartResult> {
    if (this.started) {
      throw new Error('Proxy already started');
    }

    await fs.mkdir(this.sslCacheDir, { recursive: true });

    if (this.mode === 'record') {
      const meta = harCreatorMeta(require.resolve('../package.json'));
      this.harRecorder = new HarRecorder({
        creatorName: meta.name,
        creatorVersion: meta.version
      });
    } else if (this.mode === 'replay') {
      this.harReplay = await HarReplay.load(this.harPath);
    }

    this.setupHandlers();

    await new Promise<void>((resolveListen, rejectListen) => {
      const listenOptions = {
        host: this.listenHost,
        port: this.listenPort ?? 0,
        sslCaDir: this.sslCacheDir
      };
      try {
        this.proxy.listen(listenOptions, resolveListen);
      } catch (error) {
        rejectListen(error);
      }
    });

    const caCertSource = this.proxy.ca.getCACertPath();
    await fs.mkdir(dirname(this.caCertPath), { recursive: true });
    await fs.copyFile(caCertSource, this.caCertPath);

    this.started = true;

    return {
      port: this.proxy.httpPort,
      host: this.listenHost,
      caCertPath: this.caCertPath
    };
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.mode === 'record' && this.harRecorder) {
      await fs.mkdir(dirname(this.harPath), { recursive: true });
      await this.harRecorder.save(this.harPath);
    }

    this.proxy.close();
    this.started = false;
  }

  getBlockedRequests(): readonly BlockedRequest[] {
    return [...this.blocked];
  }

  private setupHandlers(): void {
    this.proxy.onError((ctx: MitmContext | null, err?: Error | null, origin?: string) => {
      const prefix = origin ? `${origin}: ` : '';
      if (err) {
        this.logger(`${prefix}${err.message}`);
      }
    });

    this.proxy.onRequest((ctx: MitmContext, callback: ErrorCallback) => {
      const startTime = Date.now();
      const requestChunks: Buffer[] = [];

      ctx.onRequestData((_: MitmContext, chunk: Buffer, done: DataCallback) => {
        requestChunks.push(chunk);
        done();
      });

      ctx.onRequestEnd(async (_ctx: MitmContext, done: ErrorCallback) => {
        try {
          const info = extractRequestInfo(ctx);
          const requestBody = Buffer.concat(requestChunks as readonly Uint8Array[]);
          const policyAllowed = this.policy.isAllowed({
            host: info.hostname,
            port: info.port,
            method: info.method,
            path: info.path
          });

          if (!policyAllowed) {
            this.blocked.push({ url: info.url, method: info.method, reason: 'policy' });
            respondWith(ctx, 403, { 'content-type': 'application/json' }, JSON.stringify({ error: 'blocked by policy' }));
            done();
            return;
          }

          if (this.mode === 'replay') {
            const match = this.harReplay?.find(info.method, info.url, requestBody);
            if (!match) {
              this.blocked.push({ url: info.url, method: info.method, reason: 'missing-recording' });
              respondWith(ctx, 404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'no recorded response' }));
              done();
              return;
            }

            sendReplay(ctx, match);
            done();
            return;
          }

          if (this.mode === 'record' && this.harRecorder) {
            const responseChunks: Buffer[] = [];
            ctx.onResponseData((_: MitmContext, chunk: Buffer, doneResponse: DataCallback) => {
              responseChunks.push(chunk);
              doneResponse(null, chunk);
            });

            ctx.onResponseEnd((context: MitmContext, endDone: ErrorCallback) => {
              try {
                const serverResponse = context.serverToProxyResponse;
                if (!serverResponse) {
                  endDone();
                  return;
                }

                const responseBody = Buffer.concat(responseChunks as readonly Uint8Array[]);
                const input: HarRecordInput = {
                  startedDateTime: new Date(startTime).toISOString(),
                  time: Date.now() - startTime,
                  method: info.method,
                  url: info.url,
                  httpVersion: info.httpVersion,
                  requestHeaders: context.clientToProxyRequest.headers,
                  requestBody,
                  responseStatus: serverResponse.statusCode ?? 0,
                  responseStatusText: serverResponse.statusMessage ?? '',
                  responseHeaders: serverResponse.headers,
                  responseBody
                };
                this.harRecorder?.record(input);
              } finally {
                endDone();
              }
            });
          }

          callback();
        } catch (error) {
          this.logger(`proxy request error: ${(error as Error).message}`);
          respondWith(ctx, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: 'proxy failure' }));
        }
        done();
      });
    });
  }
}

type RequestInfo = {
  method: string;
  url: string;
  path: string;
  hostname: string;
  port: number;
  httpVersion: string;
};

function extractRequestInfo(ctx: MitmContext): RequestInfo {
  const method = (ctx.clientToProxyRequest.method ?? 'GET').toUpperCase();
  const path = ctx.clientToProxyRequest.url ?? '/';
  const hostHeader = ctx.clientToProxyRequest.headers.host ?? ctx.proxyToServerRequestOptions?.host ?? '';
  const { hostname, port } = splitHost(hostHeader, ctx);
  const scheme = ctx.isSSL ? 'https' : 'http';
  const url = `${scheme}://${hostHeader}${path.startsWith('/') ? path : `/${path}`}`;
  const httpVersion = `HTTP/${ctx.clientToProxyRequest.httpVersion ?? '1.1'}`;

  return {
    method,
    url,
    path: path.startsWith('/') ? path : `/${path}`,
    hostname,
    port,
    httpVersion
  };
}

function splitHost(hostHeader: string, ctx: MitmContext): { hostname: string; port: number } {
  const defaultPort = ctx.isSSL ? 443 : 80;
  if (hostHeader.includes(':')) {
    const [hostname, portStr] = hostHeader.split(':');
    const port = Number(portStr) || defaultPort;
    return { hostname: hostname.toLowerCase(), port };
  }
  const dynamicPort = ctx.proxyToServerRequestOptions?.port;
  const port = typeof dynamicPort === 'number' ? dynamicPort : defaultPort;
  return { hostname: hostHeader.toLowerCase(), port };
}

function respondWith(ctx: MitmContext, status: number, headers: Record<string, string>, body: string): void {
  const responseHeaders = { ...headers, 'content-length': Buffer.byteLength(body).toString() };
  ctx.proxyToClientResponse.writeHead(status, responseHeaders);
  ctx.proxyToClientResponse.end(body);
}

function sendReplay(ctx: MitmContext, match: HarReplayMatch): void {
  const headers = { ...match.headers };
  headers['content-length'] = match.body.length.toString();
  ctx.proxyToClientResponse.writeHead(match.status, match.statusText, headers);
  ctx.proxyToClientResponse.end(match.body);
}
